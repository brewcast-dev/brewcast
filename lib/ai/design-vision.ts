import { generateObject } from 'ai'
import { z } from 'zod'
import type { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { createGroq } from '@ai-sdk/groq'
import type { createMistral } from '@ai-sdk/mistral'

// Vision call dedicated to design decisions (separate from photo-analysis.ts,
// which is about *content* — subject, mood, filter suggestion). This call
// asks: "If you were a graphic designer laying out this photo on a 1080×1080
// Instagram post, what choices would you make?"

const DesignAnalysisSchema = z.object({
  // Normalized [x, y, width, height] in 0–1 image coords. The "important
  // thing" the design should preserve when cropping.
  subject_bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .nullable()
    .describe('Bounding box of the main subject in [x, y, w, h], 0–1 normalized. Null if no clear subject.'),
  // Up to 4 hex codes that represent the photo's dominant palette.
  dominant_palette: z
    .array(z.string())
    .max(4)
    .describe('Up to 4 hex color codes (e.g. "#1a2b3c") for the photo\'s palette.'),
  // Overall feeling — used by the compositor for tone-matching.
  mood: z.string().describe('One word: cozy, vibrant, moody, golden, gritty, clean, festive, etc.'),
  // Which edges of the image are "calm" enough to hold text without
  // obscuring the subject. Order: best-first.
  safe_text_zones: z
    .array(z.enum(['top', 'bottom', 'left', 'right', 'center']))
    .describe('Edges where text can sit without covering important content. Best zone first.'),
  // What graphic vibe fits this photo. The compositor uses this to pick
  // from a small library of decorative SVG snippets.
  decorative_vibe: z.enum(['minimal', 'vintage', 'playful', 'industrial', 'organic']),
  // How much the design should dominate the photo.
  suggested_intensity: z.enum(['subtle', 'bold', 'heavy']),
  // Which decoration would suit. The compositor maps these names to SVG.
  suggested_decorative: z
    .enum(['none', 'hops_corner', 'foam_burst', 'dotted_underline', 'vintage_frame', 'ribbon_banner', 'dashed_border', 'corner_arrow', 'starburst'])
    .describe('A single decorative element from the library, or "none".'),
  // If the photo has a strong cast (e.g. amber beer), suggest a headline
  // color that complements it. Null = use brand default cream.
  headline_color: z.string().nullable().describe('Hex color for headline text, or null to use brand default.'),
})

export type DesignAnalysis = z.infer<typeof DesignAnalysisSchema>

const SYSTEM_PROMPT = `You are an art director for a craft brewery's Instagram account. You analyse a raw photo and decide how a graphic designer would lay out a 1080×1080 social post on top of it.

Be decisive. Pick the ONE best subject, the ONE best decorative flourish (or "none"), and rank the safe zones honestly. If the photo is empty/abstract (e.g. a wall of taps with no people), the safe zones can be wide; if it's a tight portrait, only one zone may be truly safe.

For decorative_vibe + suggested_decorative:
- "minimal" / "none" — clean, type-only. Use this if the photo is already busy or premium-looking.
- "vintage" / "vintage_frame" or "ribbon_banner" — taproom interiors, brewing equipment, historical references.
- "playful" / "foam_burst" or "starburst" — events, group shots, lively scenes.
- "industrial" / "dashed_border" or "corner_arrow" — brewery floor, kegs, machinery.
- "organic" / "hops_corner" or "dotted_underline" — outdoor, ingredients, food shots.

Subject bbox: tight box around the focal point. For people, frame the face/torso. For beer pours, frame the glass. Don't include too much padding.`

export interface DesignVisionProviders {
  google: ReturnType<typeof createGoogleGenerativeAI>
  groq: ReturnType<typeof createGroq>
  mistral: ReturnType<typeof createMistral>
}

export async function analyzeForDesign(
  imageUrl: string,
  providers: DesignVisionProviders,
  brandContext?: string,
): Promise<DesignAnalysis> {
  const { google, groq, mistral } = providers

  const imageContent = [
    { type: 'image' as const, image: new URL(imageUrl) },
    {
      type: 'text' as const,
      text: [
        brandContext ? `Brand context: ${brandContext}` : '',
        'Analyse this photo for graphic design. Return the structured fields exactly as specified.',
      ].filter(Boolean).join('\n\n'),
    },
  ]

  const tryProvider = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: any,
    label: string,
  ): Promise<DesignAnalysis | null> => {
    try {
      const { object } = await generateObject({
        model,
        schema: DesignAnalysisSchema,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: imageContent }],
      })
      return object
    } catch (err) {
      console.warn(`[design-vision] ${label} failed:`, (err as Error).message.slice(0, 200))
      return null
    }
  }

  // Gemini Flash is fastest for vision. Mistral + Groq don't support vision at
  // the same fidelity but the AI SDK can still try them — they'll likely fail
  // the image content step, which is fine, we use defaults then.
  const fromGoogle = await tryProvider(google('gemini-2.5-flash'), 'gemini')
  if (fromGoogle) return fromGoogle

  // Fallback chain (best-effort — these may not be vision-capable)
  const fromMistral = await tryProvider(mistral('pixtral-12b-2409'), 'mistral-pixtral')
  if (fromMistral) return fromMistral

  // Suppress unused-var lint without changing the providers object shape
  void groq

  // Final fallback — return a neutral default so the pipeline keeps moving.
  return {
    subject_bbox: null,
    dominant_palette: [],
    mood: 'casual',
    safe_text_zones: ['bottom'],
    decorative_vibe: 'minimal',
    suggested_intensity: 'bold',
    suggested_decorative: 'none',
    headline_color: null,
  }
}

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
  // Which layout template fits the photo. Mirrors the brand's reference posts.
  //  - bold-top: bold sans headline at the top (loud, declarative — events,
  //    promos, "what's new"). Default for most photos.
  //  - serif-center: italic editorial serif centered (premium feel — menus,
  //    seasonal features, story-style content).
  //  - caps-bottom-arrow: all-caps headline at the bottom + arrow icon
  //    (call-to-action, "swipe to see more", "scroll for the menu").
  suggested_template: z
    .enum(['bold-top', 'serif-center', 'caps-bottom-arrow'])
    .describe('Which layout template to use. Defaults to bold-top for general content.'),
  // Optional amber kicker label above the headline. Short, 2–4 words, all-caps
  // friendly. Use sparingly — only when it adds real context (e.g. "TAP TAKEOVER",
  // "NEW BREW", "WEEKEND SPECIAL"). Null = no kicker.
  kicker: z.string().nullable().describe('Optional amber pill kicker above the headline (2-4 words). Null if not needed.'),
  // Which decoration would suit. The compositor maps these names to SVG.
  suggested_decorative: z
    .enum(['none', 'hops_corner', 'foam_burst', 'dotted_underline', 'vintage_frame', 'ribbon_banner', 'dashed_border', 'corner_arrow', 'starburst'])
    .describe('A single decorative element from the library, or "none". Prefer "none" for clean look.'),
  // If the photo has a strong cast (e.g. amber beer), suggest a headline
  // color that complements it. Null = use brand default cream.
  headline_color: z.string().nullable().describe('Hex color for headline text, or null to use brand default.'),
})

export type DesignAnalysis = z.infer<typeof DesignAnalysisSchema>

const SYSTEM_PROMPT = `You are an art director for a craft brewery's Instagram account. You analyse a raw photo and decide how a graphic designer would lay out a 1080×1350 social post (4:5 portrait) on top of it.

Be decisive. Pick the ONE best subject, the ONE best template, the ONE best decorative flourish (most of the time: "none"), and rank the safe zones honestly.

TEMPLATE — pick based on the photo's content and tone:
- "bold-top" — bold condensed sans headline at the TOP. Use for: events, promos, what's new, brewing process shots, big group shots. The DEFAULT choice for most posts. Loud and declarative.
- "serif-center" — italic editorial serif headline centered vertically. Use for: seasonal features, menus, premium/editorial content, food close-ups, story moments. Feels refined and curated.
- "caps-bottom-arrow" — ALL-CAPS bold headline at the bottom + arrow icon. Use for: calls-to-action ("scroll for the menu", "swipe to see more"), tap/pour/serve moments. Action-oriented.

KICKER — optional amber pill above the headline:
- Use sparingly. Only when a 2–4 word label adds real context: "TAP TAKEOVER", "NEW BREW", "WEEKEND SPECIAL", "MANGO MENU".
- Most photos: kicker = null.

DECORATIVE — almost always "none":
- The new templates already pull their weight visually. Only add a decorative if the photo really calls for one extra flourish.
- "vintage_frame" or "ribbon_banner" for historical/heritage shots.
- "foam_burst" for celebratory/event shots.
- Most photos: suggested_decorative = "none".

Subject bbox: tight box around the focal point. For people, frame the face/torso. For beer pours, frame the glass. Don't include too much padding.

Headline color: stick to null (brand cream) unless the photo has an overwhelming color cast where white/cream would disappear.`

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
    suggested_template: 'bold-top',
    kicker: null,
    suggested_decorative: 'none',
    headline_color: null,
  }
}

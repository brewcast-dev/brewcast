// AI Layout Director — the "brain" of the Design Director.
//
//   photo (+ vision hints) ──directLayout()──▶ DesignPlan
//
// An LLM (Gemini 2.5 Pro by default) looks at the photo, the brand DNA, and a
// few reference plans, then emits a structured DesignPlan. The deterministic
// renderer (./renderer) executes that plan — the LLM never touches pixels or
// renders text, so nothing is hallucinated into the final image.
//
// Built on the AI SDK's generateObject so the model is swap-able: pass a
// different `model` id, or a different provider entirely, without touching the
// schema or the renderer. Every call is metered via recordAiUsage().

import { generateObject } from 'ai'
import type { createGoogleGenerativeAI } from '@ai-sdk/google'
import { DesignPlanSchema, parseDesignPlan, type DesignPlan } from './design-plan'
import { brandDnaPromptBlock } from './brand-dna'
import { EXAMPLE_PLAN_LIST } from './example-plans'
import { recordAiUsage } from '../ai/usage'

// Default model. Swap to a newer Pro (e.g. 'gemini-3-pro') or to Claude via a
// different provider object without other changes. 2.5 Pro is the cost/quality
// sweet spot for "read one photo, output a small JSON plan".
export const DEFAULT_DIRECTOR_MODEL = 'gemini-2.5-pro'

export interface LayoutDirectorProviders {
  // Only Google is required; kept as an object so we can add fallbacks later.
  google: ReturnType<typeof createGoogleGenerativeAI>
}

export interface VisionHints {
  mood?: string | null
  subjects?: string[] | null
  description?: string | null
}

export interface DirectLayoutInput {
  // Public URL of the (already enhanced) photo. The AI SDK fetches it.
  imageUrl: string
  providers: LayoutDirectorProviders
  // Extra brand-voice text appended to the system prompt (per-user override).
  brandContext?: string
  // Optional notes from an earlier vision pass to steer the director.
  hints?: VisionHints
  // How many source photos are available. Stops the director from picking a
  // multi-photo archetype (dual/3-up) when only one photo exists.
  photoCount?: number
  // Critique from the QA loop, fed back on a regeneration attempt.
  feedback?: string
  model?: string
  userId?: string | null
}

// ─── Prompt ───────────────────────────────────────────────────────────────

function buildSystemPrompt(brandContext?: string): string {
  // Compact, readable serialization of the reference plans. These teach the
  // schema shape AND the house style. (Image+plan pairs from real reference
  // posts can be added later for stronger few-shot grounding.)
  const examples = EXAMPLE_PLAN_LIST.map(
    (p, i) => `Example ${i + 1} — ${p.archetype}:\n${JSON.stringify(p)}`,
  ).join('\n\n')

  return `You are the Art & Layout Director for District 6's social media. Given ONE photo (plus optional notes), output ONE design plan as structured data matching the provided schema. You are also the copywriter — you write the actual on-image text.

${brandDnaPromptBlock()}
${brandContext ? `\nADDITIONAL BRAND VOICE:\n${brandContext.trim()}\n` : ''}
HOW TO DECIDE:
- Pick the ONE archetype that best fits the photo's content and energy.
- Choose a photo treatment compatible with it (hero/simple → "full-bleed"; dual → "split-vertical"; editorial → "strip-3up"). Most routine single-photo posts are "full-bleed".
- Write the copy in textBlocks. Short, confident, active voice. Headlines 1–6 words. NO emojis, NO hashtags, NO exclamation marks, and never the brewery name (it's in the logo).
- Set sizeFrac / band / align / transform / shadow so text is legible. Add a scrim when text sits over a busy photo; keep upper-band text clear of the top-centre logo.
- Pick a text colour from the palette that contrasts the photo (cream is the default).
- Use a kicker pill ONLY when a 2–4 word label adds real context; otherwise null.
- decorative defaults to "none" — let typography carry the design.
- logo.show = true; treatment "cream" over dark/photo grounds.
- Fill "rationale" with one or two sentences on why these choices fit.

Match the spirit of these reference plans (one per archetype):

${examples}`
}

function buildUserText(input: DirectLayoutInput): string {
  const { hints, photoCount, feedback } = input
  const notes: string[] = []
  if (hints?.mood) notes.push(`Mood: ${hints.mood}`)
  if (hints?.subjects?.length) notes.push(`Subjects: ${hints.subjects.join(', ')}`)
  if (hints?.description) notes.push(`Description: ${hints.description}`)

  // Constrain archetype to what the available photo count can support.
  let photoRule = ''
  if (typeof photoCount === 'number') {
    if (photoCount < 2) photoRule = `Only ${photoCount} photo is available — do NOT use "dual-photo-script" or "editorial-3up"; use a single-photo archetype.`
    else if (photoCount < 3) photoRule = `${photoCount} photos available — "editorial-3up" needs 3, so avoid it.`
  }

  return [
    notes.length ? `Notes about the photo:\n${notes.join('\n')}` : '',
    photoRule,
    feedback ? `IMPORTANT — a previous attempt was rejected by QA. Fix this: ${feedback}` : '',
    'Design this post. Return the design plan exactly as specified by the schema.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ─── Director ─────────────────────────────────────────────────────────────

/**
 * Ask the LLM for a design plan. Throws on failure (provider error, or output
 * that doesn't satisfy the schema) — callers decide whether to fall back to
 * buildFallbackPlan() or the legacy compositor.
 */
export async function directLayout(input: DirectLayoutInput): Promise<DesignPlan> {
  const model = input.model ?? DEFAULT_DIRECTOR_MODEL
  const res = await generateObject({
    model: input.providers.google(model),
    schema: DesignPlanSchema,
    system: buildSystemPrompt(input.brandContext),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: new URL(input.imageUrl) },
          { type: 'text', text: buildUserText(input) },
        ],
      },
    ],
  })

  // Meter the spend (Pro calls are what actually move the prepaid budget).
  await recordAiUsage(res, {
    feature: 'layout-director',
    provider: 'google',
    model,
    userId: input.userId ?? null,
  })

  // generateObject already validated against the Zod schema; parse again so the
  // return type is a clean DesignPlan and any defaults are applied uniformly.
  return parseDesignPlan(res.object)
}

// ─── Fallback ─────────────────────────────────────────────────────────────

// A plausible, schema-valid plan to use when the director call fails, so the
// pipeline always produces something on-brand. Uses any vision hints to pick a
// generic headline; defaults to a clean full-bleed simple-photo-tagline.
export function buildFallbackPlan(opts?: { headline?: string; hints?: VisionHints; aspect?: '4:5' | '1:1' }): DesignPlan {
  const mood = (opts?.hints?.mood ?? '').toLowerCase()
  const subj = (opts?.hints?.subjects ?? []).join(' ').toLowerCase()
  let headline = opts?.headline ?? 'Fresh On Tap'
  if (!opts?.headline) {
    if (mood.includes('cozy') || mood.includes('warm') || mood.includes('golden')) headline = 'Settle In Slow'
    else if (mood.includes('moody') || mood.includes('dark') || mood.includes('noir')) headline = 'Late Night Pour'
    else if (mood.includes('vibrant') || mood.includes('festive') || mood.includes('lively')) headline = 'Pour It Up'
    else if (subj.includes('food') || subj.includes('plate')) headline = 'Pair It Up'
  }

  return parseDesignPlan({
    archetype: 'simple-photo-tagline',
    aspect: opts?.aspect ?? '4:5',
    rationale: 'Fallback plan (director unavailable): clean full-bleed photo with a short condensed tagline.',
    background: { kind: 'photo', color: null, scrim: { position: 'bottom', strength: 0.55 } },
    photo: { treatment: 'full-bleed', focal: null },
    textBlocks: [
      {
        text: headline,
        font: 'display',
        color: 'cream',
        sizeFrac: 0.075,
        band: 'bottom',
        align: 'left',
        transform: 'upper',
        trackingFrac: null,
        shadow: true,
        maxWidthFrac: 0.85,
      },
    ],
    kicker: null,
    decorative: 'none',
    logo: { show: true, treatment: 'cream' },
  })
}

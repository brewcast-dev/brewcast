// Vision QA loop — the self-check after rendering. A cheap vision model
// (Gemini Flash) looks at the FINISHED image and scores whether it reads as a
// professional, on-brand District 6 post. If it scores poorly, the pipeline
// regenerates once with the critique as feedback (see pipeline.ts).
//
// This catches the failure modes the deterministic renderer can't see on its
// own: text colliding with the logo, low-contrast headlines, awkward crops,
// clutter. Flash is used (not Pro) because scoring is mechanical and cheap.

import { generateObject } from 'ai'
import { z } from 'zod'
import type { createGoogleGenerativeAI } from '@ai-sdk/google'
import { recordAiUsage } from '../ai/usage'

export const DEFAULT_QA_MODEL = 'gemini-2.5-flash'

const QaSchema = z.object({
  score: z.number().min(0).max(100).describe('Overall quality: would a brand-conscious brewery post this as-is? 0=no, 100=flawless.'),
  onBrand: z.boolean().describe('Does it look like a polished District 6 post (clean typography, intentional layout)?'),
  legibilityOk: z.boolean().describe('Is all text easily readable against its background?'),
  logoOk: z.boolean().describe('Is the logo visible, top-centre, and not clashing/overlapping text?'),
  issues: z.array(z.string()).max(5).describe('Concrete, specific problems. Empty if none.'),
  fix: z.string().nullable().describe('The single most important concrete change to make on a re-try, phrased as an instruction. Null if the design is good.'),
})

export type QaResult = z.infer<typeof QaSchema>

const SYSTEM_PROMPT = `You are a strict art director reviewing a finished social-media post for District 6, a craft brewery. You are shown the RENDERED image. Judge it as a professional designer would.

Score harshly and concretely. A good post:
- Has clean, legible typography that reads at thumbnail size.
- Keeps text clear of the top-centre logo and the photo's key subject.
- Uses tasteful, intentional layout — not cluttered, not empty.
- Looks like it belongs on a curated brewery feed, not auto-generated.

Penalise: text overlapping the logo or running off-frame, low contrast / hard-to-read text, awkward crops that cut the subject, clutter, or anything that looks amateurish.

Return the structured fields. In "fix", give ONE actionable instruction for a re-render (e.g. "increase bottom scrim strength and move headline up — it's unreadable over the bright glass"). Null only when the design is genuinely good.`

export interface ScoreDesignInput {
  // The rendered post — pass the JPEG/PNG buffer directly.
  image: Buffer | Uint8Array
  providers: { google: ReturnType<typeof createGoogleGenerativeAI> }
  brandContext?: string
  model?: string
  userId?: string | null
}

/**
 * Score a rendered design. Throws on provider failure — callers treat a thrown
 * QA as "skip QA, ship what we have" rather than failing the whole pipeline.
 */
export async function scoreDesign(input: ScoreDesignInput): Promise<QaResult> {
  const model = input.model ?? DEFAULT_QA_MODEL
  const res = await generateObject({
    model: input.providers.google(model),
    schema: QaSchema,
    system: SYSTEM_PROMPT + (input.brandContext ? `\n\nBRAND VOICE:\n${input.brandContext.trim()}` : ''),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: input.image },
          { type: 'text', text: 'Review this finished post and return the structured critique.' },
        ],
      },
    ],
  })

  await recordAiUsage(res, { feature: 'qa-loop', provider: 'google', model, userId: input.userId ?? null })
  return res.object
}

// Threshold below which the pipeline regenerates once. Tunable.
export const QA_REGEN_THRESHOLD = 70

export function shouldRegenerate(qa: QaResult): boolean {
  return qa.score < QA_REGEN_THRESHOLD || !qa.onBrand || !qa.legibilityOk
}

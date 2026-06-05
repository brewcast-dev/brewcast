// Design Director pipeline — the full orchestration that the upload route
// calls. Ties the four stages together with graceful degradation at every
// step so it always returns a usable image:
//
//   (1) Claid photo enhancement  (optional pre-step; skipped if no key)
//   (2) AI Layout Director        → DesignPlan   (fallback plan on failure)
//   (3) Deterministic renderer    → JPEG
//   (4) Vision QA loop            → score; regenerate ONCE if off-brand
//
// Usage/cost for every LLM call is metered inside directLayout()/scoreDesign().

import type { createGoogleGenerativeAI } from '@ai-sdk/google'
import { claidImageEdit } from '../ai/claid-edit'
import { directLayout, buildFallbackPlan, type VisionHints } from './layout-director'
import { renderDesign } from './renderer'
import { scoreDesign, shouldRegenerate, type QaResult } from './qa-loop'
import type { DesignPlan } from './design-plan'

export interface DesignDirectorInput {
  // Public URL of the source photo (the director + Claid fetch it).
  imageUrl: string
  providers: { google: ReturnType<typeof createGoogleGenerativeAI> }
  logo?: Buffer | null
  brandContext?: string
  hints?: VisionHints
  // Extra photos for multi-photo archetypes. The main photo is imageUrl.
  extraPhotos?: Buffer[]
  enhance?: boolean   // Claid pre-step. Default true (no-ops without a key).
  qa?: boolean        // QA loop + single regen. Default true.
  model?: string      // director model; defaults to gemini-2.5-pro
  userId?: string | null
}

export interface DesignDirectorResult {
  buffer: Buffer
  plan: DesignPlan
  qa: QaResult | null
  regenerated: boolean
  enhancedUrl: string | null
  usedFallback: boolean
  notes: string[]
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${res.status} for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

export async function runDesignDirector(input: DesignDirectorInput): Promise<DesignDirectorResult> {
  const notes: string[] = []
  const enhance = input.enhance !== false
  const qaEnabled = input.qa !== false

  // ── (1) Claid enhancement (best-effort) ──────────────────────────────────
  let photoUrl = input.imageUrl
  let enhancedUrl: string | null = null
  if (enhance) {
    try {
      const result = await claidImageEdit({ imageUrl: input.imageUrl, mood: input.hints?.mood })
      if (result?.url) {
        enhancedUrl = result.url
        photoUrl = result.url
        notes.push('claid: enhanced')
      } else {
        notes.push('claid: skipped (no key)')
      }
    } catch (err) {
      notes.push(`claid: failed (${(err as Error).message.slice(0, 80)}) — using original`)
    }
  }

  // Source buffer(s) for the renderer (fetched from the enhanced URL if any).
  const mainBuffer = await fetchBuffer(photoUrl)
  const photos = [mainBuffer, ...(input.extraPhotos ?? [])]

  // ── (2) Director → plan (fallback on failure) ────────────────────────────
  let plan: DesignPlan
  let usedFallback = false
  try {
    plan = await directLayout({
      imageUrl: photoUrl,
      providers: input.providers,
      brandContext: input.brandContext,
      hints: input.hints,
      photoCount: photos.length,
      model: input.model,
      userId: input.userId,
    })
  } catch (err) {
    usedFallback = true
    notes.push(`director: failed (${(err as Error).message.slice(0, 120)}) — using fallback plan`)
    plan = buildFallbackPlan({ hints: input.hints })
  }

  // ── (3) Render ───────────────────────────────────────────────────────────
  let buffer = await renderDesign({ plan, photos, logo: input.logo })

  // ── (4) QA + single regenerate ───────────────────────────────────────────
  let qa: QaResult | null = null
  let regenerated = false
  if (qaEnabled) {
    try {
      qa = await scoreDesign({ image: buffer, providers: input.providers, brandContext: input.brandContext, userId: input.userId })
      notes.push(`qa: score ${qa.score}${qa.onBrand ? '' : ' (off-brand)'}`)

      // Regenerate once with the critique — but only if the first plan came
      // from the director (regenerating a fallback won't help) and QA gave a fix.
      if (!usedFallback && shouldRegenerate(qa) && qa.fix) {
        try {
          const plan2 = await directLayout({
            imageUrl: photoUrl,
            providers: input.providers,
            brandContext: input.brandContext,
            hints: input.hints,
            photoCount: photos.length,
            feedback: qa.fix,
            model: input.model,
            userId: input.userId,
          })
          const buffer2 = await renderDesign({ plan: plan2, photos, logo: input.logo })
          const qa2 = await scoreDesign({ image: buffer2, providers: input.providers, brandContext: input.brandContext, userId: input.userId })
          notes.push(`qa(regen): score ${qa2.score}`)
          regenerated = true
          // Keep the better of the two.
          if (qa2.score >= qa.score) {
            plan = plan2
            buffer = buffer2
            qa = qa2
          } else {
            notes.push('qa: kept original (regen scored lower)')
          }
        } catch (err) {
          notes.push(`qa-regen: failed (${(err as Error).message.slice(0, 80)}) — keeping original`)
        }
      }
    } catch (err) {
      notes.push(`qa: failed (${(err as Error).message.slice(0, 80)}) — shipping unscored`)
    }
  }

  return { buffer, plan, qa, regenerated, enhancedUrl, usedFallback, notes }
}

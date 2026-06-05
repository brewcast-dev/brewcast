// Deterministic renderer — the executor half of the AI Design Director.
//
//   DesignPlan + photo(s) (+ logo)  ──renderDesign()──▶  JPEG buffer
//
// No AI runs here. The same plan always produces the same pixels, and text is
// drawn from glyph geometry (text-to-path.ts), so nothing is ever hallucinated.
// Composition order: photo base → scrim → decoratives → text/kicker → logo.

import sharp from 'sharp'
import { CANVAS, type AspectKey } from '../brand-dna'
import { loadAllFonts } from '../../text-to-path'
import type { DesignPlan } from '../design-plan'
import { composePhotoBase } from './photo-treatment'
import { buildScrim } from './background'
import { renderTextLayout } from './text-block'
import { renderDecorative } from './decoratives'
import { composeLogo } from './logo'

export interface RenderDesignInput {
  plan: DesignPlan
  // One or more source photos. Single-photo treatments use the first; split /
  // strip treatments consume 2–3 (and fall back to repeating the last).
  photos: Buffer[]
  logo?: Buffer | null
  quality?: number
}

export async function renderDesign(input: RenderDesignInput): Promise<Buffer> {
  const { plan } = input
  loadAllFonts() // idempotent; warms the opentype cache

  const { w: W, h: H } = CANVAS[plan.aspect as AspectKey]

  // 1. Base layer: ground + photo(s).
  const base = await composePhotoBase({ plan, photos: input.photos, W, H })

  // 2. SVG overlay: scrim → decoratives → text + kicker.
  const scrim = buildScrim(plan, W, H)
  const text = renderTextLayout(plan, W, H)
  const decorative = renderDecorative(plan, W, H, text.headlineX, text.headlineY)

  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>${scrim.defs}</defs>
    ${scrim.rect}
    ${decorative}
    ${text.svg}
  </svg>`

  const composites: sharp.OverlayOptions[] = [{ input: Buffer.from(overlay), top: 0, left: 0 }]

  // 3. Logo on top so text/scrim never occlude it.
  const logo = await composeLogo(plan, input.logo, W, H)
  if (logo) composites.push({ input: logo.buffer, top: logo.top, left: logo.left, blend: 'over' })

  return sharp(base).composite(composites).jpeg({ quality: input.quality ?? 90 }).toBuffer()
}

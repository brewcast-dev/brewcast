// Logo — top-centre on every post (brand rule). Reuses the watermark
// pre-processor from the legacy compositor (white-outs a dark/opaque logo so it
// reads on dark grounds), then resizes to the brand width.

import sharp from 'sharp'
import { processLogoForWatermark } from '../../image-design'
import { LAYOUT } from '../brand-dna'
import type { DesignPlan } from '../design-plan'

export interface PlacedLogo {
  buffer: Buffer
  top: number
  left: number
}

/**
 * Prepare + position the logo. Returns null when there's no logo or the plan
 * says not to show it. `treatment` "dark" skips the white-out so the original
 * (presumably dark) logo is kept for light grounds; "cream"/"auto" run the
 * watermark white-out for dark grounds.
 */
export async function composeLogo(
  plan: DesignPlan,
  logo: Buffer | null | undefined,
  W: number,
  H: number,
): Promise<PlacedLogo | null> {
  if (!logo || !plan.logo.show) return null

  const source = plan.logo.treatment === 'dark' ? logo : await processLogoForWatermark(logo)
  const targetW = Math.round(W * LAYOUT.logo.widthFrac)
  const resized = await sharp(source).resize({ width: targetW }).png().toBuffer()

  const top = Math.round(LAYOUT.logo.topFrac * H)
  const left = Math.round((W - targetW) / 2)
  return { buffer: resized, top, left }
}

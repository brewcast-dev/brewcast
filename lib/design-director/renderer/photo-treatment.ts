// Photo treatment — builds the base canvas layer: a ground colour with the
// uploaded photo(s) placed per the plan's treatment. Everything else (scrim,
// text, logo) composites on top of what this returns.
//
// Returns a canvas-sized JPEG/PNG-able buffer (sRGB, no alpha needed since it
// fills the whole frame).

import sharp from 'sharp'
import { PALETTE, type PhotoTreatment } from '../brand-dna'
import type { DesignPlan } from '../design-plan'

// Map a normalized focal point (0–1) to a sharp gravity keyword so `cover`
// crops toward the subject instead of the centre. Falls back to the attention
// strategy when no focal point is given.
function focalGravity(focal: { x: number; y: number } | null): string {
  if (!focal) return 'attention'
  const v = focal.y < 0.34 ? 'north' : focal.y > 0.66 ? 'south' : ''
  const h = focal.x < 0.34 ? 'west' : focal.x > 0.66 ? 'east' : ''
  if (v && h) return v + h            // northwest / northeast / southwest / southeast
  if (v) return v
  if (h) return h
  return 'centre'
}

// Cover-fit a photo into w×h, cropping toward the focal point.
async function coverFit(
  buf: Buffer,
  w: number,
  h: number,
  focal: { x: number; y: number } | null,
): Promise<Buffer> {
  return sharp(buf)
    .resize(Math.round(w), Math.round(h), { fit: 'cover', position: focalGravity(focal) })
    .toBuffer()
}

// Pick the nth source photo, falling back to the last available one so a
// multi-photo treatment still renders when fewer photos were supplied.
function pick(photos: Buffer[], i: number): Buffer {
  if (photos.length === 0) throw new Error('photo-treatment: no source photos provided')
  return photos[Math.min(i, photos.length - 1)]
}

export interface PhotoBaseInput {
  plan: DesignPlan
  photos: Buffer[]
  W: number
  H: number
}

/**
 * Produce the base canvas: ground colour + photo(s) laid out per treatment.
 */
export async function composePhotoBase(input: PhotoBaseInput): Promise<Buffer> {
  const { plan, photos, W, H } = input
  const treatment: PhotoTreatment = plan.photo.treatment
  const focal = plan.photo.focal

  // Ground colour shows through gaps / insets / unused regions. For photo
  // backgrounds it's only visible at seams; for solid backgrounds it's the
  // canvas. Default to espresso (the house ground).
  const groundHex =
    plan.background.kind === 'solid'
      ? PALETTE[(plan.background.color ?? 'espresso') as keyof typeof PALETTE]
      : PALETTE.espresso

  const ground = sharp({
    create: { width: W, height: H, channels: 3, background: groundHex },
  })

  // Gap between stacked/striped photos so the ground reads as an intentional rule.
  const gap = Math.round(W * 0.012)

  switch (treatment) {
    case 'full-bleed': {
      // One photo fills the entire canvas.
      return coverFit(pick(photos, 0), W, H, focal)
    }

    case 'inset-frame': {
      const inset = Math.round(W * 0.06)
      const photo = await coverFit(pick(photos, 0), W - inset * 2, H - inset * 2, focal)
      return ground
        .composite([{ input: photo, top: inset, left: inset }])
        .jpeg({ quality: 92 })
        .toBuffer()
    }

    case 'top-half': {
      const ph = Math.round(H * 0.62)
      const photo = await coverFit(pick(photos, 0), W, ph, focal)
      return ground.composite([{ input: photo, top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer()
    }

    case 'bottom-half': {
      const ph = Math.round(H * 0.62)
      const photo = await coverFit(pick(photos, 0), W, ph, focal)
      return ground.composite([{ input: photo, top: H - ph, left: 0 }]).jpeg({ quality: 92 }).toBuffer()
    }

    case 'split-vertical': {
      // Two photos stacked, thin ground seam between.
      const half = Math.floor((H - gap) / 2)
      const top = await coverFit(pick(photos, 0), W, half, focal)
      const bottom = await coverFit(pick(photos, 1), W, H - gap - half, focal)
      return ground
        .composite([
          { input: top, top: 0, left: 0 },
          { input: bottom, top: half + gap, left: 0 },
        ])
        .jpeg({ quality: 92 })
        .toBuffer()
    }

    case 'strip-3up': {
      // Three vertical columns with ground seams. The strip occupies the
      // upper ~62% so a headline + body can sit on the ground beneath it.
      const stripH = Math.round(H * 0.62)
      const colW = Math.floor((W - gap * 2) / 3)
      const cols = await Promise.all([0, 1, 2].map((i) => coverFit(pick(photos, i), colW, stripH, focal)))
      return ground
        .composite([
          { input: cols[0], top: 0, left: 0 },
          { input: cols[1], top: 0, left: colW + gap },
          { input: cols[2], top: 0, left: (colW + gap) * 2 },
        ])
        .jpeg({ quality: 92 })
        .toBuffer()
    }

    default: {
      // Exhaustiveness guard — should be unreachable.
      return coverFit(pick(photos, 0), W, H, focal)
    }
  }
}

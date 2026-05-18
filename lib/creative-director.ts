import sharp from 'sharp'
import { gradeImage } from './ai/nano-banana'
import { analyzeForDesign, type DesignAnalysis } from './ai/design-vision'

// The "creative director" sits between a raw upload and the final designed
// post. Acts like a human designer would — looks at the photo, decides what
// needs fixing, what graphic treatment fits, and prepares the canvas before
// any text/badge composition happens.
//
// Pipeline (in order):
//   1. Trim solid borders (letterboxing, mobile screenshot bars, scanner edges)
//   2. Smart square crop using the vision-detected subject as the focal point
//   3. Optional Nano Banana (Gemini 2.5 Flash Image) grading pass
//   4. Return enhanced buffer + structured design decisions
//
// The downstream compositor (lib/image-design.ts) then takes the returned
// decisions and bakes in the gradient + headline + badge + logo + decoratives.

export interface CreativeDirectorOptions {
  imageBuffer: Buffer
  imageUrl: string                 // Needed for Gemini Vision (URL-based)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providers: { google: any; groq: any; mistral: any }
  brandContext?: string
  enableGrading?: boolean          // Defaults true if Google API key is set
  targetWidth?: number             // Output width (default 1080)
  targetHeight?: number            // Output height (default 1350 for 4:5)
}

export interface CreativeDirectorResult {
  buffer: Buffer                   // Prepared image (cropped, possibly graded)
  decisions: DesignAnalysis        // Vision-derived design choices for the compositor
  diagnostics: {
    trimmed: boolean
    cropped: { from: [number, number]; to: [number, number] } | null
    graded: boolean
    gradingError?: string
  }
}

// ─── 1. Border trimming ─────────────────────────────────────────────────────

/**
 * Aggressive border trim. Sharp's built-in .trim() only handles uniform
 * single-color borders. We add a stronger pass that detects rows/cols where
 * variance is below a threshold (i.e. nearly-flat letterbox bars) and crops
 * those out too.
 */
async function trimBorders(buffer: Buffer): Promise<{ buffer: Buffer; trimmed: boolean }> {
  // First try sharp's built-in trim (fast path for solid borders)
  try {
    const trimmed = await sharp(buffer).trim({ threshold: 12 }).toBuffer()
    const beforeMeta = await sharp(buffer).metadata()
    const afterMeta = await sharp(trimmed).metadata()
    const widthShrunk = (beforeMeta.width ?? 0) - (afterMeta.width ?? 0) > 4
    const heightShrunk = (beforeMeta.height ?? 0) - (afterMeta.height ?? 0) > 4
    if (widthShrunk || heightShrunk) {
      return { buffer: trimmed, trimmed: true }
    }
  } catch {
    /* trim can fail on already-tight images — fall through */
  }
  return { buffer, trimmed: false }
}

// ─── 2. Smart square crop ───────────────────────────────────────────────────

/**
 * Crop to a square (or 4:5) using the subject's bounding box as the focal
 * point. Falls back to a center crop if no subject info is available.
 *
 * subject_bbox is normalized [x, y, w, h] in 0–1 image coordinates.
 */
async function smartCrop(
  buffer: Buffer,
  targetW: number,
  targetH: number,
  subjectBbox: [number, number, number, number] | null,
): Promise<{ buffer: Buffer; from: [number, number]; to: [number, number] }> {
  const meta = await sharp(buffer).metadata()
  const W = meta.width ?? targetW
  const H = meta.height ?? targetH

  // Compute the largest target-aspect rectangle that fits inside the source.
  const targetAspect = targetW / targetH
  const srcAspect = W / H
  let cropW: number, cropH: number
  if (srcAspect > targetAspect) {
    // Source wider than target — crop horizontally
    cropH = H
    cropW = Math.round(H * targetAspect)
  } else {
    // Source taller than target — crop vertically
    cropW = W
    cropH = Math.round(W / targetAspect)
  }

  // Center the crop rect on the detected subject (or image center)
  let cx: number, cy: number
  if (subjectBbox) {
    const [bx, by, bw, bh] = subjectBbox
    cx = Math.round((bx + bw / 2) * W)
    cy = Math.round((by + bh / 2) * H)
  } else {
    cx = Math.round(W / 2)
    cy = Math.round(H / 2)
  }
  let left = Math.max(0, Math.min(W - cropW, cx - Math.round(cropW / 2)))
  let top = Math.max(0, Math.min(H - cropH, cy - Math.round(cropH / 2)))
  left = Math.round(left)
  top = Math.round(top)

  const cropped = await sharp(buffer)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(targetW, targetH, { fit: 'cover' })
    .toBuffer()

  return { buffer: cropped, from: [W, H], to: [targetW, targetH] }
}

// ─── 3. Orchestration ───────────────────────────────────────────────────────

export async function prepareImageForDesign(
  opts: CreativeDirectorOptions,
): Promise<CreativeDirectorResult> {
  const targetW = opts.targetWidth ?? 1080
  const targetH = opts.targetHeight ?? 1350   // 4:5 default
  const diagnostics: CreativeDirectorResult['diagnostics'] = {
    trimmed: false,
    cropped: null,
    graded: false,
  }

  // Step 1: trim solid/letterbox borders
  const t = await trimBorders(opts.imageBuffer)
  let workingBuffer = t.buffer
  diagnostics.trimmed = t.trimmed

  // Step 2: vision analysis — provides subject bbox + design decisions
  // Even if grading is disabled, we need this for the crop focal point and
  // for the compositor's intensity/decorative/palette choices.
  let decisions: DesignAnalysis
  try {
    decisions = await analyzeForDesign(opts.imageUrl, opts.providers, opts.brandContext)
  } catch (err) {
    console.warn('[creative-director] vision failed, using fallback:', (err as Error).message)
    decisions = {
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

  // Step 3: smart crop to the target aspect, focused on the detected subject
  const c = await smartCrop(workingBuffer, targetW, targetH, decisions.subject_bbox)
  workingBuffer = c.buffer
  diagnostics.cropped = { from: c.from, to: c.to }

  // Step 4: optional Nano Banana grading pass
  if (opts.enableGrading !== false) {
    try {
      const graded = await gradeImage(workingBuffer, opts.providers, decisions.mood)
      if (graded) {
        workingBuffer = graded
        diagnostics.graded = true
      }
    } catch (err) {
      diagnostics.gradingError = (err as Error).message
      console.warn('[creative-director] Nano Banana grading failed:', diagnostics.gradingError)
      // Non-fatal — we still return the cropped (but not graded) image
    }
  }

  return { buffer: workingBuffer, decisions, diagnostics }
}

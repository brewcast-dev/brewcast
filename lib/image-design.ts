import sharp from 'sharp'
import fs from 'fs'
import path from 'path'

// ─── Font embedding ─────────────────────────────────────────────────────────
// Vercel's serverless runtime has no display fonts installed, so we MUST
// bundle our own and inline them base64 in the SVG's @font-face. Without
// this, every <text> element falls back to tofu (▢▢▢) on production.
//
// Fonts loaded once at module init and reused across composites.

interface EmbeddedFonts {
  displayB64: string | null
  bodyB64: string | null
}

let _fontsCache: EmbeddedFonts | null = null

function loadEmbeddedFonts(): EmbeddedFonts {
  if (_fontsCache) return _fontsCache
  const fontsDir = path.join(process.cwd(), 'public', 'brand', 'fonts')
  const tryRead = (file: string): string | null => {
    try {
      return fs.readFileSync(path.join(fontsDir, file)).toString('base64')
    } catch {
      return null
    }
  }
  _fontsCache = {
    displayB64: tryRead('Anton-Regular.ttf'),
    bodyB64: tryRead('Inter-Variable.ttf'),
  }
  if (!_fontsCache.displayB64 || !_fontsCache.bodyB64) {
    console.warn('[image-design] Bundled fonts missing — text will tofu on Vercel. Expected public/brand/fonts/{Anton-Regular,Inter-Variable}.ttf')
  }
  return _fontsCache
}

function fontFaceCss(fonts: EmbeddedFonts): string {
  const parts: string[] = []
  if (fonts.displayB64) {
    parts.push(`@font-face { font-family: 'BrewDisplay'; src: url('data:font/ttf;base64,${fonts.displayB64}') format('truetype'); font-weight: 100 900; }`)
  }
  if (fonts.bodyB64) {
    parts.push(`@font-face { font-family: 'BrewBody'; src: url('data:font/ttf;base64,${fonts.bodyB64}') format('truetype'); font-weight: 100 900; }`)
  }
  return parts.join('\n        ')
}

// Server-side image designer. Takes a raw brewery photo and bakes a
// designed layer on top: gradient for legibility, AI-written headline,
// brewery handle watermark, optional logo, optional badge.
//
// Three intensity presets control how much the design dominates the photo:
//   subtle:  small bottom strip, ~1 line of headline, 22% of image height
//   bold:    large top + bottom strips with bigger type, ~35% of image
//   heavy:   marquee-style headline overlaid on darkened photo, ~50%

export type DesignIntensity = 'subtle' | 'bold' | 'heavy'

export interface DesignInput {
  imageBuffer: Buffer
  headline: string         // 1–6 words. The big bold phrase.
  subhead?: string         // Optional 3–10 word follow-up.
  handle?: string          // e.g. "@district6bangalore"
  badge?: string           // Short pill text (e.g. "Tap Takeover", "New Brew")
  intensity: DesignIntensity
  logoBuffer?: Buffer      // Optional PNG/SVG; placed in a corner
  colors?: Partial<BrandColors>
}

export interface BrandColors {
  cream: string   // light text + bright accents
  amber: string   // secondary accent
  ink: string     // dark gradient bg
}

const DEFAULT_COLORS: BrandColors = {
  cream: '#f5f0e1',
  amber: '#f59e0b',
  ink: '#0f172a',
}

// ─── Logo auto-processing ──────────────────────────────────────────────────
// Many brand logos ship as black-on-white PNG/JPG. For watermarking on photos
// we want white-on-transparent. This transforms ANY input into a white-ink
// silhouette by treating brightness as inverse alpha — bright pixels become
// transparent, dark pixels become opaque white.

// Cache processed logos in-process: re-processing on every composite would
// be slow + wasteful. Keyed by buffer reference.
const processedLogoCache = new WeakMap<Buffer, Buffer>()

async function processLogoForWatermark(rawLogo: Buffer): Promise<Buffer> {
  const cached = processedLogoCache.get(rawLogo)
  if (cached) return cached

  // First check: if the input already has alpha channel with meaningful
  // transparency, assume it's already a clean transparent PNG and use as-is.
  const meta = await sharp(rawLogo).metadata()
  if (meta.hasAlpha) {
    // Sample a few pixels to detect if alpha is actually used (a PNG can have
    // an alpha channel that's 100% opaque everywhere).
    const { data } = await sharp(rawLogo).raw().toBuffer({ resolveWithObject: true })
    const alphaIdx = 3
    const channels = meta.channels ?? 4
    let hasTransparency = false
    for (let i = alphaIdx; i < data.length; i += channels) {
      if (data[i] < 250) { hasTransparency = true; break }
    }
    if (hasTransparency) {
      processedLogoCache.set(rawLogo, rawLogo)
      return rawLogo
    }
  }

  // Black-on-white (or grayscale-on-white) → white-on-transparent.
  // 1. Convert to grayscale to get per-pixel brightness
  // 2. Build an RGBA buffer: rgb=white, a=255-brightness
  const { data: gray, info } = await sharp(rawLogo)
    .removeAlpha()
    .toColorspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true })

  const rgba = Buffer.alloc(info.width * info.height * 4)
  for (let i = 0; i < gray.length; i++) {
    const brightness = gray[i]
    // Slight contrast curve — a faint pixel (180/255) should still be mostly
    // transparent so light grays in the source don't muddy the watermark.
    const alpha = Math.max(0, 255 - Math.round(brightness * 1.1))
    rgba[i * 4]     = 255
    rgba[i * 4 + 1] = 255
    rgba[i * 4 + 2] = 255
    rgba[i * 4 + 3] = alpha
  }

  const processed = await sharp(rgba, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toBuffer()

  processedLogoCache.set(rawLogo, processed)
  return processed
}

// XML-escape strings injected into the SVG (headlines from AI can contain
// arbitrary characters including & < > " — these would break SVG parse).
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Wrap long headlines onto multiple lines so they don't overflow the canvas.
// Used by the SVG renderer to position each line with its own <tspan>.
function wrapWords(text: string, maxWordsPerLine: number): string[] {
  const words = text.trim().split(/\s+/)
  const lines: string[] = []
  for (let i = 0; i < words.length; i += maxWordsPerLine) {
    lines.push(words.slice(i, i + maxWordsPerLine).join(' '))
  }
  return lines
}

interface RenderConfig {
  // SVG-relative font sizes (the SVG matches the photo's pixel dimensions)
  headlineSize: number
  subheadSize: number
  handleSize: number
  badgeSize: number
  headlineWords: number  // wrap rule
  // Gradient strip height as a fraction of image height (0–1)
  gradientFrac: number
  // Where the gradient sits: top, bottom, or full
  gradientPos: 'top' | 'bottom' | 'full'
  // Darken multiplier over the photo behind the gradient (0–1)
  scrim: number
  // Headline font weight
  headlineWeight: number
}

const PRESETS: Record<DesignIntensity, RenderConfig> = {
  subtle: {
    headlineSize: 0.055, subheadSize: 0.028, handleSize: 0.022, badgeSize: 0.022,
    headlineWords: 5, gradientFrac: 0.32, gradientPos: 'bottom', scrim: 0.35, headlineWeight: 800,
  },
  bold: {
    headlineSize: 0.09, subheadSize: 0.032, handleSize: 0.024, badgeSize: 0.025,
    headlineWords: 3, gradientFrac: 0.45, gradientPos: 'bottom', scrim: 0.5, headlineWeight: 900,
  },
  heavy: {
    headlineSize: 0.14, subheadSize: 0.035, handleSize: 0.026, badgeSize: 0.028,
    headlineWords: 2, gradientFrac: 1.0, gradientPos: 'full', scrim: 0.55, headlineWeight: 900,
  },
}

/**
 * Composite the design layer over the photo and return a JPEG buffer.
 */
export async function composeDesignedImage(input: DesignInput): Promise<Buffer> {
  const colors = { ...DEFAULT_COLORS, ...input.colors }
  const preset = PRESETS[input.intensity]

  // Read the photo's dimensions so we can build a same-size SVG overlay.
  const baseImg = sharp(input.imageBuffer)
  const meta = await baseImg.metadata()
  const W = meta.width ?? 1080
  const H = meta.height ?? 1080

  const headlineLines = wrapWords(input.headline, preset.headlineWords)
  const headlinePx = Math.round(H * preset.headlineSize)
  const subheadPx = Math.round(H * preset.subheadSize)
  const handlePx = Math.round(H * preset.handleSize)
  const badgePx = Math.round(H * preset.badgeSize)

  const gradH = Math.round(H * preset.gradientFrac)
  const gradY = preset.gradientPos === 'top' ? 0 : preset.gradientPos === 'full' ? 0 : H - gradH

  // Text block sits near the bottom of the gradient strip with a margin
  const margin = Math.round(W * 0.05)
  const lineHeight = 1.05
  const headlineY = preset.gradientPos === 'top'
    ? Math.round(margin + headlinePx)
    : Math.round(H - margin - (input.subhead ? subheadPx + margin * 0.4 : 0))

  // Build SVG overlay
  const headlineSvg = headlineLines
    .map((line, i) => {
      const yOffset = preset.gradientPos === 'top'
        ? headlineY + i * headlinePx * lineHeight
        : headlineY - (headlineLines.length - 1 - i) * headlinePx * lineHeight
      return `<text x="${margin}" y="${yOffset}" class="headline">${xmlEscape(line)}</text>`
    })
    .join('')

  const subheadSvg = input.subhead
    ? `<text x="${margin}" y="${headlineY + subheadPx * 1.4}" class="subhead">${xmlEscape(input.subhead)}</text>`
    : ''

  const handleSvg = input.handle
    ? `<text x="${W - margin}" y="${H - margin}" text-anchor="end" class="handle">${xmlEscape(input.handle)}</text>`
    : ''

  // Pill-style badge in the top-left corner
  const badgeSvg = input.badge
    ? (() => {
        const padX = badgePx * 0.55
        const padY = badgePx * 0.32
        const approxW = input.badge.length * badgePx * 0.55 + padX * 2
        const x = margin
        const y = margin
        return `
          <rect x="${x}" y="${y}" width="${approxW}" height="${badgePx + padY * 2}"
                rx="${(badgePx + padY * 2) / 2}" fill="${colors.amber}" opacity="0.95" />
          <text x="${x + padX}" y="${y + badgePx + padY * 0.85}" class="badge">${xmlEscape(input.badge)}</text>
        `
      })()
    : ''

  // Gradient strip — multistop for a smoother falloff
  let gradientDef = ''
  let gradientRect = ''
  if (preset.gradientPos === 'bottom') {
    gradientDef = `
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${colors.ink}" stop-opacity="0"/>
        <stop offset="60%" stop-color="${colors.ink}" stop-opacity="${preset.scrim * 0.85}"/>
        <stop offset="100%" stop-color="${colors.ink}" stop-opacity="${preset.scrim}"/>
      </linearGradient>`
    gradientRect = `<rect x="0" y="${gradY}" width="${W}" height="${gradH}" fill="url(#scrim)"/>`
  } else if (preset.gradientPos === 'top') {
    gradientDef = `
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${colors.ink}" stop-opacity="${preset.scrim}"/>
        <stop offset="100%" stop-color="${colors.ink}" stop-opacity="0"/>
      </linearGradient>`
    gradientRect = `<rect x="0" y="${gradY}" width="${W}" height="${gradH}" fill="url(#scrim)"/>`
  } else {
    gradientDef = `
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${colors.ink}" stop-opacity="${preset.scrim * 0.7}"/>
        <stop offset="50%" stop-color="${colors.ink}" stop-opacity="0"/>
        <stop offset="100%" stop-color="${colors.ink}" stop-opacity="${preset.scrim}"/>
      </linearGradient>`
    gradientRect = `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#scrim)"/>`
  }

  // Headline + subhead style.
  // Fonts are bundled at public/brand/fonts/ and embedded base64 into the SVG
  // so they render reliably on Vercel's fontless serverless runtime.
  const fonts = loadEmbeddedFonts()
  const headlineFont = fonts.displayB64
    ? `'BrewDisplay', 'Impact', 'Arial Black', sans-serif`
    : `'Impact', 'Helvetica Neue', 'Arial Black', sans-serif`
  const bodyFont = fonts.bodyB64
    ? `'BrewBody', 'Helvetica Neue', Arial, sans-serif`
    : `'Helvetica Neue', Arial, sans-serif`

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      ${gradientDef}
      <style>
        ${fontFaceCss(fonts)}
        .headline { font-family: ${headlineFont}; font-weight: ${preset.headlineWeight};
                    font-size: ${headlinePx}px; fill: ${colors.cream}; letter-spacing: -1.5px; }
        .subhead  { font-family: ${bodyFont}; font-weight: 500;
                    font-size: ${subheadPx}px; fill: ${colors.cream}; opacity: 0.85; }
        .handle   { font-family: ${bodyFont}; font-weight: 600;
                    font-size: ${handlePx}px; fill: ${colors.cream}; opacity: 0.9; letter-spacing: 0.5px; }
        .badge    { font-family: ${bodyFont}; font-weight: 700;
                    font-size: ${badgePx}px; fill: ${colors.ink}; letter-spacing: 0.5px; text-transform: uppercase; }
      </style>
    </defs>
    ${gradientRect}
    ${badgeSvg}
    ${headlineSvg}
    ${subheadSvg}
    ${handleSvg}
  </svg>`

  // Composite: photo → gradient/text SVG → optional logo PNG
  const composites: sharp.OverlayOptions[] = [{ input: Buffer.from(svg), top: 0, left: 0 }]

  if (input.logoBuffer) {
    // Auto-process: if the input is a flat black-on-white logo (no alpha),
    // we strip white → transparent and invert ink to white so it watermarks
    // cleanly on any photo. If it's already a clean transparent PNG, used as-is.
    const watermarkSource = await processLogoForWatermark(input.logoBuffer)

    // Resize to ~14% of image width and place top-right.
    const logoTargetW = Math.round(W * 0.14)
    const logoResized = await sharp(watermarkSource)
      .resize({ width: logoTargetW })
      .png()
      .toBuffer()
    composites.push({
      input: logoResized,
      top: margin,
      left: W - margin - logoTargetW,
      blend: 'over',
    })
  }

  return baseImg.composite(composites).jpeg({ quality: 88 }).toBuffer()
}

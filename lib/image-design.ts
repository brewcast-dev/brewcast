import sharp from 'sharp'
import { buildDecorativeSvg, type DecorativeKind } from './design-decoratives'
import { loadAllFonts, renderText, wrapTextToWidth, measureText } from './text-to-path'

// Server-side image designer. Takes a prepared photo (cropped + graded by
// the creative director) and bakes a designed layer on top using one of
// several "templates" — each a distinct layout pattern modeled after the
// brand's reference posts (District 6's IG grid).

// ─── Output config ──────────────────────────────────────────────────────────

export const OUTPUT_W = 1080
export const OUTPUT_H = 1350         // 4:5 portrait by default
export const OUTPUT_SQUARE = 1080    // when caller wants 1:1

// ─── Template system ────────────────────────────────────────────────────────

/**
 * Template names. The creative director picks one based on the photo's
 * vibe; the upload UI can also force a specific template.
 *
 *  - bold-top        : Anton condensed headline at the top, drop-shadowed
 *  - serif-center    : Editorial italic serif centered (image 4 style)
 *  - caps-bottom-arrow : All-caps headline at the bottom + drawn arrow below
 *  - comparison      : Anton headline at top + 2-row CRAFT BEER / COMMERCIAL
 *                      BEER comparison block at the bottom
 */
export type DesignTemplate =
  | 'bold-top'
  | 'serif-center'
  | 'caps-bottom-arrow'
  | 'comparison'

// Legacy alias kept for callers — maps to the new template names.
export type DesignIntensity = 'subtle' | 'bold' | 'heavy'

function intensityToTemplate(i: DesignIntensity): DesignTemplate {
  if (i === 'subtle') return 'serif-center'
  if (i === 'heavy') return 'caps-bottom-arrow'
  return 'bold-top'
}

export interface ComparisonRow {
  kicker: string                // amber-colored label like "CRAFT BEER"
  body: string                  // descriptive text
}

export interface DesignInput {
  imageBuffer: Buffer
  headline: string              // 1–6 words. The big bold phrase.
  subhead?: string              // Optional supporting line. Not used by all templates.
  handle?: string               // e.g. "@district6bangalore"
  kicker?: string               // Amber pill above the headline (image 4 style)
  badge?: string                // Legacy alias for kicker. Used if kicker is missing.
  template?: DesignTemplate     // What layout to use. Defaults via intensity.
  intensity?: DesignIntensity   // Back-compat — mapped to template if template missing.
  comparisons?: ComparisonRow[] // Required when template === 'comparison'
  logoBuffer?: Buffer           // Optional brewery logo (PNG/JPG, B/W or transparent)
  colors?: Partial<BrandColors>
  decorative?: DecorativeKind   // Optional decorative SVG overlay
  headlineColor?: string | null // Vision-suggested override; default brand cream
  // Output dimensions — default 1080×1350 (4:5). Pass square to force 1:1.
  aspect?: '4:5' | '1:1'
}

export interface BrandColors {
  cream: string
  amber: string
  ink: string
}

const DEFAULT_COLORS: BrandColors = {
  cream: '#f5f0e1',
  amber: '#f5b740',
  ink: '#0f172a',
}

// ─── Logo auto-processing (unchanged — works well) ─────────────────────────

const processedLogoCache = new WeakMap<Buffer, Buffer>()

async function processLogoForWatermark(rawLogo: Buffer): Promise<Buffer> {
  const cached = processedLogoCache.get(rawLogo)
  if (cached) return cached

  const meta = await sharp(rawLogo).metadata()
  if (meta.hasAlpha) {
    const { data } = await sharp(rawLogo).raw().toBuffer({ resolveWithObject: true })
    const channels = meta.channels ?? 4
    let hasTransparency = false
    for (let i = 3; i < data.length; i += channels) {
      if (data[i] < 250) { hasTransparency = true; break }
    }
    if (hasTransparency) {
      processedLogoCache.set(rawLogo, rawLogo)
      return rawLogo
    }
  }

  const { data: gray, info } = await sharp(rawLogo)
    .removeAlpha()
    .toColorspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true })

  const rgba = Buffer.alloc(info.width * info.height * 4)
  for (let i = 0; i < gray.length; i++) {
    const brightness = gray[i]
    const alpha = Math.max(0, 255 - Math.round(brightness * 1.1))
    rgba[i * 4] = 255
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

// ─── Shadow preset (used by every template) ────────────────────────────────

const HEADLINE_SHADOW = {
  offsetX: 0,
  offsetY: 4,
  blur: 6,
  color: '#000000',
  opacity: 0.55,
}

// ─── Template renderers ─────────────────────────────────────────────────────
// Each returns a complete <svg> document string (without the closing </svg>;
// callers append their own decoratives + close).

interface RenderCtx {
  W: number
  H: number
  colors: BrandColors
  headlineFill: string
  margin: number
  // Y-coordinate (px) of the bottom edge of the logo zone, including
  // margin. 0 if no logo. Templates that put text at the top use this
  // to push the headline below the logo so the two don't collide.
  logoBottom: number
}

function renderBoldTop(input: DesignInput, ctx: RenderCtx): { svg: string; headlineY: number; headlineX: number } {
  const { W, H, colors, headlineFill, margin, logoBottom } = ctx
  const headlineSize = Math.round(H * 0.085)
  const maxWidth = W - margin * 2
  const lines = wrapTextToWidth(input.headline, 'display', headlineSize, maxWidth)

  // Headline anchored top-left, just below logo zone. Pick the LATER of
  // a fixed 13% top inset and (logo bottom + breathing room) so a tall
  // logo never gets overlapped by the headline.
  const headlineTop = Math.max(Math.round(H * 0.13), logoBottom + Math.round(H * 0.03))
  const headlineY = headlineTop + headlineSize
  const head = renderText({
    text: input.headline,
    lines,
    font: 'display',
    fontSize: headlineSize,
    x: margin,
    y: headlineY,
    color: headlineFill,
    anchor: 'start',
    shadow: HEADLINE_SHADOW,
    lineHeight: 1.0,
  })

  // Optional subhead under the headline
  let subSvg = ''
  if (input.subhead) {
    const subSize = Math.round(H * 0.028)
    const subY = headlineY + head.totalHeight + Math.round(subSize * 0.6)
    const subLines = wrapTextToWidth(input.subhead, 'body', subSize, maxWidth)
    subSvg = renderText({
      text: input.subhead,
      lines: subLines,
      font: 'body',
      fontSize: subSize,
      x: margin,
      y: subY,
      color: colors.cream,
      opacity: 0.9,
      anchor: 'start',
      lineHeight: 1.25,
    }).svg
  }

  return { svg: head.svg + subSvg, headlineY, headlineX: margin }
}

function renderSerifCenter(input: DesignInput, ctx: RenderCtx): { svg: string; headlineY: number; headlineX: number } {
  const { W, H, colors, headlineFill, margin } = ctx
  const headlineSize = Math.round(H * 0.075)
  const maxWidth = W - margin * 2
  const lines = wrapTextToWidth(input.headline, 'serif', headlineSize, maxWidth)

  // Stack: optional kicker pill, then headline. All centered horizontally.
  let cursorY = Math.round(H * 0.38)

  // Kicker pill (image 4 style)
  let kickerSvg = ''
  const kickerText = input.kicker ?? input.badge
  if (kickerText) {
    const kickSize = Math.round(H * 0.022)
    const padX = kickSize * 0.85
    const padY = kickSize * 0.45
    const w = measureText(kickerText, 'body', kickSize) + padX * 2
    const x = (W - w) / 2
    const y = cursorY
    const rendered = renderText({
      text: kickerText,
      font: 'body',
      fontSize: kickSize,
      x: W / 2,
      y: y + kickSize + padY * 0.6,
      color: colors.cream,
      anchor: 'middle',
    })
    kickerSvg = `
      <rect x="${x}" y="${y}" width="${w}" height="${kickSize + padY * 2}"
            rx="${(kickSize + padY * 2) / 2}" fill="${colors.amber}" opacity="0.95"/>
      ${rendered.svg}`
    cursorY += kickSize + padY * 2 + Math.round(H * 0.025)
  }

  // Headline
  const headY = cursorY + headlineSize
  const head = renderText({
    text: input.headline,
    lines,
    font: 'serif',
    fontSize: headlineSize,
    x: W / 2,
    y: headY,
    color: headlineFill,
    anchor: 'middle',
    shadow: HEADLINE_SHADOW,
    lineHeight: 1.1,
  })

  return { svg: kickerSvg + head.svg, headlineY: headY, headlineX: W / 2 }
}

function renderCapsBottomArrow(input: DesignInput, ctx: RenderCtx): { svg: string; headlineY: number; headlineX: number } {
  const { W, H, colors, headlineFill, margin } = ctx
  const headlineSize = Math.round(H * 0.055)
  const maxWidth = W - margin * 2
  const upper = input.headline.toUpperCase()
  const lines = wrapTextToWidth(upper, 'display', headlineSize, maxWidth)

  // Headline near bottom, centered
  const arrowH = Math.round(H * 0.08)
  const headY = H - Math.round(H * 0.08) - arrowH
  const head = renderText({
    text: upper,
    lines,
    font: 'display',
    fontSize: headlineSize,
    x: W / 2,
    y: headY,
    color: headlineFill,
    anchor: 'middle',
    shadow: HEADLINE_SHADOW,
    letterSpacing: 1.5,
    lineHeight: 1.05,
  })

  // Hand-drawn-ish double-down arrow under the headline
  const arrowCx = W / 2
  const arrowTop = headY + head.totalHeight * 0.2 + Math.round(H * 0.015)
  const arrowSize = Math.round(H * 0.05)
  const stroke = Math.max(2, Math.round(H * 0.0035))
  const arrowSvg = `
    <g stroke="${colors.cream}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.92">
      <!-- left arrow -->
      <path d="M ${arrowCx - arrowSize * 0.6} ${arrowTop}
               L ${arrowCx - arrowSize * 0.6} ${arrowTop + arrowSize * 0.9}"/>
      <path d="M ${arrowCx - arrowSize * 0.9} ${arrowTop + arrowSize * 0.55}
               L ${arrowCx - arrowSize * 0.6} ${arrowTop + arrowSize * 0.9}
               L ${arrowCx - arrowSize * 0.3} ${arrowTop + arrowSize * 0.55}"/>
      <!-- right arrow -->
      <path d="M ${arrowCx + arrowSize * 0.6} ${arrowTop}
               L ${arrowCx + arrowSize * 0.6} ${arrowTop + arrowSize * 0.9}"/>
      <path d="M ${arrowCx + arrowSize * 0.9} ${arrowTop + arrowSize * 0.55}
               L ${arrowCx + arrowSize * 0.6} ${arrowTop + arrowSize * 0.9}
               L ${arrowCx + arrowSize * 0.3} ${arrowTop + arrowSize * 0.55}"/>
    </g>`

  return { svg: head.svg + arrowSvg, headlineY: headY, headlineX: W / 2 }
}

function renderComparison(input: DesignInput, ctx: RenderCtx): { svg: string; headlineY: number; headlineX: number } {
  const { W, H, colors, headlineFill, margin, logoBottom } = ctx
  // Headline at top — pushed below the logo zone if a logo is present
  const headlineSize = Math.round(H * 0.075)
  const maxWidth = W - margin * 2
  const lines = wrapTextToWidth(input.headline, 'display', headlineSize, maxWidth)
  const headTop = Math.max(Math.round(H * 0.13), logoBottom + Math.round(H * 0.03))
  const headY = headTop + headlineSize
  const head = renderText({
    text: input.headline,
    lines,
    font: 'display',
    fontSize: headlineSize,
    x: margin,
    y: headY,
    color: headlineFill,
    anchor: 'start',
    shadow: HEADLINE_SHADOW,
    lineHeight: 1.0,
  })

  // Comparison block at the bottom — 2 rows of {kicker, body} with a divider
  let blockSvg = ''
  const rows = (input.comparisons ?? []).slice(0, 2)
  if (rows.length > 0) {
    const kickerSize = Math.round(H * 0.026)
    const bodySize = Math.round(H * 0.022)
    const rowGap = Math.round(H * 0.012)
    const dividerGap = Math.round(H * 0.018)
    const blockBottom = H - Math.round(H * 0.065)
    const dividerThickness = Math.max(1, Math.round(H * 0.0012))

    // Build from bottom up so we can stack into the bottom margin reliably
    let cursorY = blockBottom

    if (rows[1]) {
      const r = rows[1]
      const body = renderText({
        text: r.body,
        font: 'body',
        fontSize: bodySize,
        x: margin,
        y: cursorY,
        color: colors.cream,
        anchor: 'start',
        opacity: 0.95,
      })
      cursorY -= bodySize + rowGap
      const kicker = renderText({
        text: r.kicker.toUpperCase(),
        font: 'display',
        fontSize: kickerSize,
        x: margin,
        y: cursorY,
        color: colors.amber,
        anchor: 'start',
        letterSpacing: 1,
      })
      cursorY -= kickerSize + dividerGap
      blockSvg = body.svg + kicker.svg + blockSvg
    }

    if (rows[1] && rows[0]) {
      const dividerY = cursorY
      blockSvg = `<line x1="${margin}" y1="${dividerY}" x2="${W - margin}" y2="${dividerY}"
                        stroke="${colors.cream}" stroke-width="${dividerThickness}" opacity="0.55"/>` + blockSvg
      cursorY -= dividerGap
    }

    if (rows[0]) {
      const r = rows[0]
      const body = renderText({
        text: r.body,
        font: 'body',
        fontSize: bodySize,
        x: margin,
        y: cursorY,
        color: colors.cream,
        anchor: 'start',
        opacity: 0.95,
      })
      cursorY -= bodySize + rowGap
      const kicker = renderText({
        text: r.kicker.toUpperCase(),
        font: 'display',
        fontSize: kickerSize,
        x: margin,
        y: cursorY,
        color: colors.amber,
        anchor: 'start',
        letterSpacing: 1,
      })
      blockSvg = body.svg + kicker.svg + blockSvg
    }
  }

  return { svg: head.svg + blockSvg, headlineY: headY, headlineX: margin }
}

// ─── Compositor ─────────────────────────────────────────────────────────────

export async function composeDesignedImage(input: DesignInput): Promise<Buffer> {
  // Pre-warm font cache (idempotent)
  loadAllFonts()

  const colors = { ...DEFAULT_COLORS, ...input.colors }
  const headlineFill = input.headlineColor || colors.cream

  // Pick template (back-compat: map intensity if explicit template missing)
  const template: DesignTemplate =
    input.template ??
    (input.intensity ? intensityToTemplate(input.intensity) : 'bold-top')

  // Output dimensions
  const aspect = input.aspect ?? '4:5'
  const W = aspect === '1:1' ? OUTPUT_SQUARE : OUTPUT_W
  const H = aspect === '1:1' ? OUTPUT_SQUARE : OUTPUT_H

  // Resize photo to fit the canvas via cover crop. Creative director already
  // smart-cropped, so this is just the final fit.
  const photoFit = await sharp(input.imageBuffer)
    .resize(W, H, { fit: 'cover', position: 'attention' })
    .toBuffer()

  const margin = Math.round(W * 0.055)

  // ── Logo pre-processing ───────────────────────────────────────────────────
  // Resize the logo up-front so we know its actual height and can position
  // the headline below it (instead of overlapping). We composite it last
  // (after the SVG overlay) below.
  let logoResized: Buffer | null = null
  let logoLeft = 0
  let logoTop = margin
  let logoBottom = 0
  const logoTargetW = Math.round(W * 0.16)
  if (input.logoBuffer) {
    const watermarkSource = await processLogoForWatermark(input.logoBuffer)
    logoResized = await sharp(watermarkSource).resize({ width: logoTargetW }).png().toBuffer()
    const logoMeta = await sharp(logoResized).metadata()
    const logoH = logoMeta.height ?? logoTargetW
    logoLeft = Math.round((W - logoTargetW) / 2)
    logoBottom = logoTop + logoH
  }

  const ctx: RenderCtx = { W, H, colors, headlineFill, margin, logoBottom }

  // ── Gradient scrim (per template) ─────────────────────────────────────────
  let gradientSvg = ''
  switch (template) {
    case 'bold-top':
    case 'comparison':
      // Both: dark gradient top + bottom for legibility
      gradientSvg = `
        <linearGradient id="topScrim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${colors.ink}" stop-opacity="0.65"/>
          <stop offset="100%" stop-color="${colors.ink}" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="botScrim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${colors.ink}" stop-opacity="0"/>
          <stop offset="100%" stop-color="${colors.ink}" stop-opacity="${template === 'comparison' ? 0.85 : 0.55}"/>
        </linearGradient>
      `
      break
    case 'serif-center':
      gradientSvg = `
        <linearGradient id="midScrim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${colors.ink}" stop-opacity="0.35"/>
          <stop offset="50%" stop-color="${colors.ink}" stop-opacity="0.5"/>
          <stop offset="100%" stop-color="${colors.ink}" stop-opacity="0.35"/>
        </linearGradient>
      `
      break
    case 'caps-bottom-arrow':
      gradientSvg = `
        <linearGradient id="botScrim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${colors.ink}" stop-opacity="0"/>
          <stop offset="60%" stop-color="${colors.ink}" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="${colors.ink}" stop-opacity="0.8"/>
        </linearGradient>
      `
      break
  }

  let gradientRects = ''
  if (template === 'bold-top' || template === 'comparison') {
    const topH = Math.round(H * 0.28)
    const botH = template === 'comparison' ? Math.round(H * 0.42) : Math.round(H * 0.20)
    gradientRects = `
      <rect x="0" y="0" width="${W}" height="${topH}" fill="url(#topScrim)"/>
      <rect x="0" y="${H - botH}" width="${W}" height="${botH}" fill="url(#botScrim)"/>
    `
  } else if (template === 'serif-center') {
    gradientRects = `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#midScrim)"/>`
  } else {
    const botH = Math.round(H * 0.45)
    gradientRects = `<rect x="0" y="${H - botH}" width="${W}" height="${botH}" fill="url(#botScrim)"/>`
  }

  // ── Template-specific layout ──────────────────────────────────────────────
  let layout: { svg: string; headlineY: number; headlineX: number }
  switch (template) {
    case 'bold-top':         layout = renderBoldTop(input, ctx);         break
    case 'serif-center':     layout = renderSerifCenter(input, ctx);     break
    case 'caps-bottom-arrow':layout = renderCapsBottomArrow(input, ctx); break
    case 'comparison':       layout = renderComparison(input, ctx);      break
  }

  // ── Handle (bottom-right, always, unless caps-bottom-arrow which has the arrow there) ─
  let handleSvg = ''
  if (input.handle && template !== 'caps-bottom-arrow' && template !== 'comparison') {
    const handleSize = Math.round(H * 0.018)
    const rendered = renderText({
      text: input.handle,
      font: 'body',
      fontSize: handleSize,
      x: W - margin,
      y: H - margin,
      color: colors.cream,
      anchor: 'end',
      opacity: 0.85,
      letterSpacing: 0.5,
    })
    handleSvg = rendered.svg
  }

  // ── Decorative SVG snippet (optional) ─────────────────────────────────────
  const decorativeSvg = input.decorative && input.decorative !== 'none'
    ? buildDecorativeSvg(input.decorative, {
        W, H,
        cream: colors.cream,
        amber: colors.amber,
        headlineY: layout.headlineY,
        headlineX: layout.headlineX,
        gradientPos: template === 'caps-bottom-arrow' ? 'bottom' : template === 'serif-center' ? 'full' : 'bottom',
      })
    : ''

  // ── Final SVG document ────────────────────────────────────────────────────
  const overlaySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>${gradientSvg}</defs>
    ${gradientRects}
    ${decorativeSvg}
    ${layout.svg}
    ${handleSvg}
  </svg>`

  // ── Composite ─────────────────────────────────────────────────────────────
  // Order: photo (base) → SVG overlay (text, gradient, decoratives) → logo.
  // Logo on top so it never gets occluded by text or scrim.
  const composites: sharp.OverlayOptions[] = [{ input: Buffer.from(overlaySvg), top: 0, left: 0 }]

  if (logoResized) {
    composites.push({
      input: logoResized,
      top: logoTop,
      left: logoLeft,
      blend: 'over',
    })
  }

  return sharp(photoFit).composite(composites).jpeg({ quality: 90 }).toBuffer()
}

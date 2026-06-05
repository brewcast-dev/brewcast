// Text layout — turns the plan's text blocks (and optional kicker) into SVG
// glyph paths. All measurement/wrapping/anchoring reuses text-to-path.ts so we
// inherit its Vercel-safe, GSUB-skipping glyph rendering.
//
// Blocks are grouped by their `band`; each group is vertically centred on the
// band's anchor and stacked. Upper-band groups are pushed clear of the
// top-centre logo zone so the two never collide.

import {
  renderText,
  wrapTextToWidth,
  measureText,
  type FontKey,
} from '../../text-to-path'
import { PALETTE, FONTS, LAYOUT, type LayoutBand } from '../brand-dna'
import type { DesignPlan, TextBlockPlan } from '../design-plan'

// Vertical anchor (fraction of H) each band centres its text group on.
const BAND_CENTER: Record<LayoutBand, number> = {
  top: 0.13,
  'upper-third': 0.26,
  center: 0.5,
  'lower-third': 0.72,
  bottom: 0.88,
}

const HEADLINE_SHADOW = {
  offsetX: 0,
  offsetY: 4,
  blur: 6,
  color: '#000000',
  opacity: 0.55,
}

function applyTransform(text: string, transform: TextBlockPlan['transform']): string {
  if (transform === 'upper') return text.toUpperCase()
  if (transform === 'title') {
    return text.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
  }
  return text
}

// Script faces want tighter leading; condensed/serif a touch more open.
function lineHeightFor(font: FontKey): number {
  if (font === 'script') return 0.98
  if (font === 'display') return 1.02
  return 1.12
}

interface LaidBlock {
  text: string
  font: FontKey
  fontSize: number
  lines: string[]
  x: number
  anchor: 'start' | 'middle' | 'end'
  color: string
  tracking: number
  lineHeight: number
  shadow: boolean
  top: number      // visual top y of the block
  height: number
}

export interface TextLayoutResult {
  svg: string
  // Anchor of the dominant (largest) text block — decoratives orient to it.
  headlineX: number
  headlineY: number
}

export function renderTextLayout(plan: DesignPlan, W: number, H: number): TextLayoutResult {
  const marginPx = Math.round(LAYOUT.marginFrac * W)
  const contentW = W - marginPx * 2
  const logoZoneBottom = plan.logo.show ? Math.round(LAYOUT.logo.zoneBottomFrac * H) : 0

  // 1. Measure every block.
  const measured = plan.textBlocks.map((b) => {
    const fontSize = Math.max(8, Math.round(b.sizeFrac * H))
    const text = applyTransform(b.text, b.transform)
    const maxWidthPx = (b.maxWidthFrac ?? 1 - LAYOUT.marginFrac * 2) * W
    const lines = wrapTextToWidth(text, b.font, fontSize, Math.min(maxWidthPx, contentW))
    const lineHeight = lineHeightFor(b.font)
    const tracking = (b.trackingFrac ?? FONTS[b.font].tracking) * fontSize
    const x = b.align === 'center' ? W / 2 : b.align === 'right' ? W - marginPx : marginPx
    const anchor: LaidBlock['anchor'] = b.align === 'center' ? 'middle' : b.align === 'right' ? 'end' : 'start'
    return {
      band: b.band,
      block: b,
      text,
      fontSize,
      lines,
      lineHeight,
      tracking,
      x,
      anchor,
      color: PALETTE[b.color],
      shadow: b.shadow,
      height: lines.length * fontSize * lineHeight,
    }
  })

  // 2. Group by band (preserving order) and place each group.
  const laid: LaidBlock[] = []
  const interGap = Math.round(H * 0.012)
  const bands = measured.map((m) => m.band).filter((b, i, arr) => arr.indexOf(b) === i)

  for (const band of bands) {
    const group = measured.filter((m) => m.band === band)
    const groupHeight = group.reduce((s, g) => s + g.height, 0) + interGap * (group.length - 1)
    let top = BAND_CENTER[band] * H - groupHeight / 2

    // Keep upper-band text below the logo, and everything inside the margins.
    if ((band === 'top' || band === 'upper-third') && logoZoneBottom > 0) {
      top = Math.max(top, logoZoneBottom + Math.round(H * 0.02))
    }
    top = Math.max(top, marginPx)
    if (top + groupHeight > H - marginPx) top = H - marginPx - groupHeight

    let cursor = top
    for (const g of group) {
      laid.push({
        text: g.text,
        font: g.block.font,
        fontSize: g.fontSize,
        lines: g.lines,
        x: g.x,
        anchor: g.anchor,
        color: g.color,
        tracking: g.tracking,
        lineHeight: g.lineHeight,
        shadow: g.shadow,
        top: cursor,
        height: g.height,
      })
      cursor += g.height + interGap
    }
  }

  // 3. Render each block to SVG.
  const parts: string[] = []
  for (const b of laid) {
    const r = renderText({
      text: b.text,
      lines: b.lines,
      font: b.font,
      fontSize: b.fontSize,
      x: b.x,
      y: b.top + b.fontSize,           // baseline of first line
      color: b.color,
      anchor: b.anchor,
      letterSpacing: b.tracking,
      lineHeight: b.lineHeight,
      shadow: b.shadow ? HEADLINE_SHADOW : undefined,
    })
    parts.push(r.svg)
  }

  // 4. Kicker pill — placed above the topmost block (or under the logo zone).
  let kickerSvg = ''
  if (plan.kicker) {
    const topMost = laid.reduce<LaidBlock | null>((min, b) => (!min || b.top < min.top ? b : min), null)
    const kickSize = Math.round(H * 0.02)
    const label = plan.kicker.text.toUpperCase()
    const padX = kickSize * 0.85
    const padY = kickSize * 0.5
    const pillW = measureText(label, 'body', kickSize) + padX * 2
    const pillH = kickSize + padY * 2
    const cx = topMost ? topMost.x : W / 2
    const pillX = (topMost?.anchor === 'start' ? cx : topMost?.anchor === 'end' ? cx - pillW : cx - pillW / 2)
    const pillBottom = topMost ? topMost.top - Math.round(H * 0.012) : Math.round(LAYOUT.logo.zoneBottomFrac * H) + pillH
    const pillY = pillBottom - pillH
    const textR = renderText({
      text: label,
      font: 'body',
      fontSize: kickSize,
      x: pillX + pillW / 2,
      y: pillY + kickSize + padY * 0.55,
      color: PALETTE.espresso,
      anchor: 'middle',
      letterSpacing: kickSize * 0.06,
    })
    kickerSvg = `<rect x="${pillX.toFixed(1)}" y="${pillY.toFixed(1)}" width="${pillW.toFixed(1)}" height="${pillH.toFixed(1)}" rx="${(pillH / 2).toFixed(1)}" fill="${PALETTE[plan.kicker.color]}"/>${textR.svg}`
  }

  // 5. Dominant block anchor for decoratives.
  const dominant = laid.reduce<LaidBlock | null>((max, b) => (!max || b.fontSize > max.fontSize ? b : max), null)
  const headlineX = dominant ? dominant.x : W / 2
  const headlineY = dominant ? dominant.top + dominant.height : H / 2

  return { svg: kickerSvg + parts.join(''), headlineX, headlineY }
}

// A small library of decorative SVG snippets that get composited onto the
// designed posts. Each function returns a snippet sized to the canvas — the
// caller embeds the returned string inside the main SVG document.
//
// All snippets use coordinates in pixels relative to the canvas top-left.
// Colors come from the brand palette (cream / ink) so they look intentional.

export type DecorativeKind =
  | 'none'
  | 'hops_corner'
  | 'foam_burst'
  | 'dotted_underline'
  | 'vintage_frame'
  | 'ribbon_banner'
  | 'dashed_border'
  | 'corner_arrow'
  | 'starburst'

export interface DecorativeContext {
  W: number
  H: number
  cream: string   // light brand color (text/lines)
  amber: string   // accent
  // Where the headline lives — decoratives near the headline get placed
  // relative to it so they don't fight for space.
  headlineY: number
  headlineX: number
  gradientPos: 'top' | 'bottom' | 'full'
}

export function buildDecorativeSvg(
  kind: DecorativeKind,
  ctx: DecorativeContext,
): string {
  switch (kind) {
    case 'none':
      return ''
    case 'hops_corner':
      return hopsCorner(ctx)
    case 'foam_burst':
      return foamBurst(ctx)
    case 'dotted_underline':
      return dottedUnderline(ctx)
    case 'vintage_frame':
      return vintageFrame(ctx)
    case 'ribbon_banner':
      return ribbonBanner(ctx)
    case 'dashed_border':
      return dashedBorder(ctx)
    case 'corner_arrow':
      return cornerArrow(ctx)
    case 'starburst':
      return starburst(ctx)
    default:
      return ''
  }
}

// ─── Individual decoratives ─────────────────────────────────────────────────

function hopsCorner({ W, H, cream, gradientPos }: DecorativeContext): string {
  // Top-left if headline is at bottom (so they don't fight). Otherwise bot-left.
  const corner = gradientPos === 'bottom' ? 'tl' : 'bl'
  const cx = corner === 'tl' ? Math.round(W * 0.06) : Math.round(W * 0.06)
  const cy = corner === 'tl' ? Math.round(H * 0.06) : Math.round(H * 0.94)
  const r = Math.round(W * 0.035)
  // Hop cone: stacked teardrops
  const drop = (dx: number, dy: number, rot: number, scale = 1) =>
    `<path d="M0 -${r * scale} Q${r * 0.55 * scale} -${r * 0.55 * scale} 0 ${r * scale} Q${-r * 0.55 * scale} ${-r * 0.55 * scale} 0 -${r * scale} Z" transform="translate(${cx + dx} ${cy + dy}) rotate(${rot})" fill="${cream}" opacity="0.85"/>`
  return [
    drop(0, 0, 0),
    drop(-r * 0.8, r * 0.4, -30, 0.85),
    drop(r * 0.8, r * 0.4, 30, 0.85),
    drop(0, r * 1.1, 0, 0.7),
  ].join('')
}

function foamBurst({ W, H, cream, headlineX, headlineY, gradientPos }: DecorativeContext): string {
  // Cluster of circles near the headline, like beer foam bubbles.
  const baseY = gradientPos === 'bottom' ? headlineY - Math.round(H * 0.08) : headlineY + Math.round(H * 0.04)
  const baseX = headlineX + Math.round(W * 0.02)
  const circles: string[] = []
  const bubble = (dx: number, dy: number, r: number, opacity: number) =>
    `<circle cx="${baseX + dx}" cy="${baseY + dy}" r="${r}" fill="${cream}" opacity="${opacity}"/>`
  circles.push(bubble(0, 0, Math.round(W * 0.012), 0.9))
  circles.push(bubble(Math.round(W * 0.022), Math.round(W * -0.008), Math.round(W * 0.008), 0.7))
  circles.push(bubble(Math.round(W * -0.018), Math.round(W * 0.005), Math.round(W * 0.009), 0.65))
  circles.push(bubble(Math.round(W * 0.035), Math.round(W * 0.012), Math.round(W * 0.005), 0.5))
  circles.push(bubble(Math.round(W * -0.030), Math.round(W * -0.015), Math.round(W * 0.006), 0.55))
  return circles.join('')
}

function dottedUnderline({ W, headlineX, headlineY, cream }: DecorativeContext): string {
  // Row of dots beneath the headline.
  const dotR = Math.max(2, Math.round(W * 0.005))
  const gap = dotR * 3
  const y = headlineY + Math.round(W * 0.025)
  const count = Math.floor(W * 0.18 / gap)
  return Array.from({ length: count }, (_, i) =>
    `<circle cx="${headlineX + i * gap}" cy="${y}" r="${dotR}" fill="${cream}" opacity="0.85"/>`
  ).join('')
}

function vintageFrame({ W, H, cream }: DecorativeContext): string {
  // Inset border with small ornamental corners
  const inset = Math.round(W * 0.04)
  const stroke = Math.max(1, Math.round(W * 0.002))
  const cornerL = Math.round(W * 0.035)
  return `
    <rect x="${inset}" y="${inset}" width="${W - inset * 2}" height="${H - inset * 2}"
          fill="none" stroke="${cream}" stroke-width="${stroke}" opacity="0.55"/>
    <path d="M ${inset} ${inset + cornerL} L ${inset} ${inset} L ${inset + cornerL} ${inset}"
          fill="none" stroke="${cream}" stroke-width="${stroke * 2}" opacity="0.85"/>
    <path d="M ${W - inset - cornerL} ${inset} L ${W - inset} ${inset} L ${W - inset} ${inset + cornerL}"
          fill="none" stroke="${cream}" stroke-width="${stroke * 2}" opacity="0.85"/>
    <path d="M ${inset} ${H - inset - cornerL} L ${inset} ${H - inset} L ${inset + cornerL} ${H - inset}"
          fill="none" stroke="${cream}" stroke-width="${stroke * 2}" opacity="0.85"/>
    <path d="M ${W - inset - cornerL} ${H - inset} L ${W - inset} ${H - inset} L ${W - inset} ${H - inset - cornerL}"
          fill="none" stroke="${cream}" stroke-width="${stroke * 2}" opacity="0.85"/>
  `
}

function ribbonBanner({ W, H, cream, amber, gradientPos }: DecorativeContext): string {
  // Horizontal banner with notched ends. Position above the headline.
  const bannerH = Math.round(H * 0.04)
  const bannerW = Math.round(W * 0.32)
  const y = gradientPos === 'bottom' ? Math.round(H * 0.78) : Math.round(H * 0.18)
  const x = Math.round(W * 0.05)
  const notch = bannerH / 2
  return `
    <path d="M ${x} ${y}
             L ${x + bannerW} ${y}
             L ${x + bannerW - notch} ${y + bannerH / 2}
             L ${x + bannerW} ${y + bannerH}
             L ${x} ${y + bannerH}
             L ${x + notch} ${y + bannerH / 2}
             Z"
          fill="${amber}" opacity="0.9"/>
    <line x1="${x + notch + 8}" y1="${y + bannerH / 2}" x2="${x + bannerW - notch - 8}" y2="${y + bannerH / 2}"
          stroke="${cream}" stroke-width="1.5" opacity="0.6" stroke-dasharray="3,3"/>
  `
}

function dashedBorder({ W, H, cream }: DecorativeContext): string {
  const inset = Math.round(W * 0.03)
  const stroke = Math.max(1, Math.round(W * 0.0025))
  return `<rect x="${inset}" y="${inset}" width="${W - inset * 2}" height="${H - inset * 2}"
          fill="none" stroke="${cream}" stroke-width="${stroke}"
          stroke-dasharray="${stroke * 6},${stroke * 4}" opacity="0.6"/>`
}

function cornerArrow({ W, H, cream, gradientPos }: DecorativeContext): string {
  const margin = Math.round(W * 0.06)
  const size = Math.round(W * 0.06)
  // Place opposite the headline
  const x = gradientPos === 'bottom' ? margin : W - margin - size
  const y = gradientPos === 'bottom' ? margin : H - margin - size
  return `
    <g transform="translate(${x} ${y})">
      <path d="M 0 ${size * 0.2} L ${size * 0.8} ${size * 0.2} L ${size * 0.6} 0
               M ${size * 0.8} ${size * 0.2} L ${size * 0.6} ${size * 0.4}"
            fill="none" stroke="${cream}" stroke-width="${Math.max(1, Math.round(W * 0.003))}"
            stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
      <path d="M ${size * 0.2} 0 L ${size * 0.2} ${size * 0.8} L 0 ${size * 0.6}
               M ${size * 0.2} ${size * 0.8} L ${size * 0.4} ${size * 0.6}"
            fill="none" stroke="${cream}" stroke-width="${Math.max(1, Math.round(W * 0.003))}"
            stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
    </g>
  `
}

function starburst({ W, H, amber, headlineX, gradientPos }: DecorativeContext): string {
  // Sun/burst lines emanating from a point near the headline corner
  const cx = headlineX + Math.round(W * 0.6)
  const cy = gradientPos === 'bottom' ? Math.round(H * 0.72) : Math.round(H * 0.28)
  const inner = Math.round(W * 0.015)
  const outer = Math.round(W * 0.045)
  const stroke = Math.max(1, Math.round(W * 0.0025))
  const rays: string[] = []
  for (let i = 0; i < 12; i++) {
    const angle = (i * Math.PI * 2) / 12
    const x1 = cx + Math.cos(angle) * inner
    const y1 = cy + Math.sin(angle) * inner
    const x2 = cx + Math.cos(angle) * outer
    const y2 = cy + Math.sin(angle) * outer
    rays.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${amber}" stroke-width="${stroke}" stroke-linecap="round" opacity="0.9"/>`)
  }
  return rays.join('')
}

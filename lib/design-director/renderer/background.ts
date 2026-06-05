// Background scrim — the darkening gradient laid over the photo so text stays
// legible. The solid-vs-photo ground itself is handled in photo-treatment.ts;
// this module only produces the scrim overlay.
//
// Returns SVG fragments: `defs` (the gradient definition) and `rect` (the
// painted rectangle). The compositor merges all module `defs` into one <defs>.

import { PALETTE } from '../brand-dna'
import type { DesignPlan } from '../design-plan'

export interface ScrimSvg {
  defs: string
  rect: string
}

const EMPTY: ScrimSvg = { defs: '', rect: '' }

export function buildScrim(plan: DesignPlan, W: number, H: number): ScrimSvg {
  const s = plan.background.scrim
  if (!s || s.position === 'none' || s.strength <= 0) return EMPTY

  const ink = PALETTE.ink
  const a = Math.min(1, Math.max(0, s.strength))
  const id = `scrim_${Math.random().toString(36).slice(2, 8)}`

  if (s.position === 'full') {
    // Even wash across the whole frame — used to knock back a busy photo
    // behind centred text (e.g. the dual-photo script word).
    const defs = `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${ink}" stop-opacity="${(a * 0.9).toFixed(3)}"/>
        <stop offset="50%" stop-color="${ink}" stop-opacity="${a.toFixed(3)}"/>
        <stop offset="100%" stop-color="${ink}" stop-opacity="${(a * 0.9).toFixed(3)}"/>
      </linearGradient>`
    return { defs, rect: `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#${id})"/>` }
  }

  // Top or bottom: opaque at the edge where the text lives, fading to clear
  // toward the middle so the photo still breathes.
  const fromTop = s.position === 'top'
  const bandH = Math.round(H * 0.4)
  const y = fromTop ? 0 : H - bandH
  const defs = `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${ink}" stop-opacity="${fromTop ? a.toFixed(3) : '0'}"/>
      <stop offset="100%" stop-color="${ink}" stop-opacity="${fromTop ? '0' : a.toFixed(3)}"/>
    </linearGradient>`
  return { defs, rect: `<rect x="0" y="${y}" width="${W}" height="${bandH}" fill="url(#${id})"/>` }
}

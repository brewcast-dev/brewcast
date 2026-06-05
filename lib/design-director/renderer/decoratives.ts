// Decoratives — thin adapter onto the existing SVG atom library
// (lib/design-decoratives.ts). The plan names one atom (or "none"); we feed it
// the canvas + the dominant headline anchor so atoms place themselves sensibly.

import { buildDecorativeSvg, type DecorativeKind as LibDecorativeKind } from '../../design-decoratives'
import { PALETTE } from '../brand-dna'
import type { DesignPlan } from '../design-plan'

export function renderDecorative(
  plan: DesignPlan,
  W: number,
  H: number,
  headlineX: number,
  headlineY: number,
): string {
  if (!plan.decorative || plan.decorative === 'none') return ''

  // The atom library positions some elements relative to where the headline
  // gradient sits; map the scrim position onto its 'top' | 'bottom' | 'full'.
  const gradientPos =
    plan.background.scrim?.position === 'top'
      ? 'top'
      : plan.background.scrim?.position === 'full'
        ? 'full'
        : 'bottom'

  return buildDecorativeSvg(plan.decorative as LibDecorativeKind, {
    W,
    H,
    cream: PALETTE.cream,
    amber: PALETTE.amber,
    headlineX,
    headlineY,
    gradientPos,
  })
}

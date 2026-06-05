// Hand-authored design plans — one per archetype. These exist so the
// renderer (Days 3–5) can be built and tested against known-good input
// BEFORE the AI Layout Director is wired in. They double as the few-shot
// examples the director will be primed with, and as regression fixtures.
//
// Each is run through parseDesignPlan() at module load, so if the schema and
// these fixtures ever drift, importing this file throws immediately rather
// than failing silently at render time.

import { parseDesignPlan, type DesignPlan } from './design-plan'

// 1. HERO PRODUCT — full-bleed product shot, loud condensed caps, the
//    "RIPE. COLD. PERFECT." energy. Headline sits bottom over a scrim.
const heroProduct: DesignPlan = parseDesignPlan({
  archetype: 'hero-product',
  aspect: '4:5',
  rationale: 'A crisp hero pour deserves to fill the frame; a bold condensed caps headline over a bottom scrim keeps it loud without hiding the product.',
  background: {
    kind: 'photo',
    color: null,
    scrim: { position: 'bottom', strength: 0.6 },
  },
  photo: {
    treatment: 'full-bleed',
    focal: { x: 0.5, y: 0.42 },
  },
  textBlocks: [
    {
      text: 'Ripe. Cold. Perfect.',
      font: 'display',
      color: 'cream',
      sizeFrac: 0.09,
      band: 'bottom',
      align: 'left',
      transform: 'upper',
      trackingFrac: null,
      shadow: true,
      maxWidthFrac: 0.8,
    },
  ],
  kicker: { text: 'NEW POUR', color: 'amber' },
  decorative: 'none',
  logo: { show: true, treatment: 'cream' },
})

// 2. SIMPLE PHOTO + TAGLINE — the everyday workhorse. One photo, a short
//    condensed tagline near the top under the logo, clean.
const simplePhotoTagline: DesignPlan = parseDesignPlan({
  archetype: 'simple-photo-tagline',
  aspect: '4:5',
  rationale: 'A relaxed venue shot with a short declarative tagline up top; a light top scrim seats the text under the logo without dominating the photo.',
  background: {
    kind: 'photo',
    color: null,
    scrim: { position: 'top', strength: 0.5 },
  },
  photo: {
    treatment: 'full-bleed',
    focal: { x: 0.5, y: 0.55 },
  },
  textBlocks: [
    {
      text: 'Fresh On Tap',
      font: 'display',
      color: 'cream',
      sizeFrac: 0.07,
      band: 'upper-third',
      align: 'center',
      transform: 'upper',
      trackingFrac: 0.04,
      shadow: true,
      maxWidthFrac: 0.9,
    },
  ],
  kicker: null,
  decorative: 'none',
  logo: { show: true, treatment: 'cream' },
})

// 3. DUAL PHOTO SCRIPT — two food photos stacked, one elegant script word
//    overlapping the seam. Solid espresso ground shows at the centre seam.
const dualPhotoScript: DesignPlan = parseDesignPlan({
  archetype: 'dual-photo-script',
  aspect: '4:5',
  rationale: 'Two indulgent food shots stacked, with a single flowing script word straddling the seam — the brand\'s signature elegant-overlap treatment.',
  background: {
    kind: 'photo',
    color: null,
    scrim: { position: 'full', strength: 0.25 },
  },
  photo: {
    treatment: 'split-vertical',
    focal: { x: 0.5, y: 0.5 },
  },
  textBlocks: [
    {
      text: 'Heavenly',
      font: 'script',
      color: 'cream',
      sizeFrac: 0.13,
      band: 'center',
      align: 'center',
      transform: 'as-typed',
      trackingFrac: null,
      shadow: true,
      maxWidthFrac: 0.85,
    },
  ],
  kicker: null,
  decorative: 'none',
  logo: { show: true, treatment: 'cream' },
})

// 4. EDITORIAL 3-UP — three-photo vertical strip, a vertical date label, a
//    refined serif headline and a body line. The magazine archetype, on a
//    solid forest ground.
const editorial3up: DesignPlan = parseDesignPlan({
  archetype: 'editorial-3up',
  aspect: '4:5',
  rationale: 'A curated seasonal story: a three-photo strip over a forest ground, an editorial serif headline, and a supporting body line for the magazine feel.',
  background: {
    kind: 'solid',
    color: 'forest',
    scrim: { position: 'none', strength: 0 },
  },
  photo: {
    treatment: 'strip-3up',
    focal: { x: 0.5, y: 0.5 },
  },
  textBlocks: [
    {
      text: 'A Season of Flavor',
      font: 'serif',
      color: 'cream',
      sizeFrac: 0.06,
      band: 'lower-third',
      align: 'center',
      transform: 'title',
      trackingFrac: null,
      shadow: false,
      maxWidthFrac: 0.85,
    },
    {
      text: 'New small plates, poured to match — all season long.',
      font: 'body',
      color: 'cream',
      sizeFrac: 0.022,
      band: 'bottom',
      align: 'center',
      transform: 'as-typed',
      trackingFrac: null,
      shadow: false,
      maxWidthFrac: 0.75,
    },
  ],
  kicker: { text: 'SEASONAL', color: 'amber' },
  decorative: 'none',
  logo: { show: true, treatment: 'cream' },
})

export const EXAMPLE_PLANS: Record<string, DesignPlan> = {
  'hero-product': heroProduct,
  'simple-photo-tagline': simplePhotoTagline,
  'dual-photo-script': dualPhotoScript,
  'editorial-3up': editorial3up,
}

// Ordered list for few-shot prompting / iteration.
export const EXAMPLE_PLAN_LIST: DesignPlan[] = [
  heroProduct,
  simplePhotoTagline,
  dualPhotoScript,
  editorial3up,
]

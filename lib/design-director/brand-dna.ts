// District 6 brand DNA — the single source of truth for the AI Design
// Director. Both halves of the pipeline read from this file:
//
//   • The AI Layout Director serializes it into the prompt (so the LLM knows
//     the fonts, palette, regions, and decoratives it is allowed to use).
//   • The deterministic renderer reads the concrete values (hex codes, font
//     keys, pixel margins) when it executes the plan.
//
// Keeping them in one place means the LLM can never invent a colour or font
// the renderer doesn't have. The design plan schema (design-plan.ts) derives
// its enums from the identifiers exported here.
//
// Distilled from District 6's actual IG feed (https://instagram.com/district6blr):
// logo top-centre on every post, 4:5 portrait dominant, dark espresso/forest/
// black grounds or full-bleed photo, four typeface families, restrained
// decoration.

import type { FontKey } from '../text-to-path'

// ─── Canvas ───────────────────────────────────────────────────────────────

export const CANVAS = {
  // 4:5 portrait is the dominant format in the feed; 1:1 is the fallback for
  // grid-tile or carousel cover use.
  '4:5': { w: 1080, h: 1350 },
  '1:1': { w: 1080, h: 1080 },
} as const

export type AspectKey = keyof typeof CANVAS

// ─── Typography ─────────────────────────────────────────────────────────────
// Four families, each with one job. `key` maps to the opentype loader in
// text-to-path.ts. v1 uses Google Fonts approximations; real brand TTFs swap
// in later by replacing the files and these notes stay valid.

export interface FontRole {
  key: FontKey
  family: string          // human-readable name (for the prompt)
  role: string            // when the director should reach for it
  case: 'upper' | 'title' | 'as-typed'
  // Sensible tracking (letter-spacing as a fraction of font size) so caps
  // faces breathe and the script stays tight.
  tracking: number
}

export const FONTS: Record<'display' | 'serif' | 'body' | 'script', FontRole> = {
  // Bold condensed caps — the loud, declarative voice. RIPE. COLD. PERFECT.
  display: {
    key: 'display',
    family: 'Anton (≈ Bebas Neue)',
    role: 'Bold condensed all-caps headlines. Loud, declarative — product drops, events, big statements.',
    case: 'upper',
    tracking: 0.02,
  },
  // Refined editorial italic serif — the curated, premium voice.
  serif: {
    key: 'serif',
    family: 'DM Serif Display Italic (≈ Playfair Display)',
    role: 'Refined editorial headlines and seasonal/menu features. Premium, story-style.',
    case: 'title',
    tracking: 0,
  },
  // Flowing script — the elegant accent word that overlaps photos.
  script: {
    key: 'script',
    family: 'Allura',
    role: 'A single elegant accent word that overlaps photography (e.g. "Heavenly", "Cheers"). Never for body or full sentences.',
    case: 'as-typed',
    tracking: 0,
  },
  // Clean sans — supporting text, dates, handles, body, kicker pills.
  body: {
    key: 'body',
    family: 'Inter',
    role: 'Body copy, sub-lines, dates, the @handle, kicker-pill labels. The quiet workhorse.',
    case: 'as-typed',
    tracking: 0,
  },
}

// ─── Palette ──────────────────────────────────────────────────────────────
// Named brand colours. Backgrounds skew dark and warm; cream is the default
// ink-on-dark text colour; amber is the single accent. Hex values align with
// the legacy compositor's DEFAULT_COLORS so old and new paths look identical.

export const PALETTE = {
  // Light — default text on dark grounds / photos.
  cream: '#f5f0e1',
  // Accent — kicker pills, kickers, the occasional headline word. Use sparingly.
  amber: '#f5b740',
  // Dark grounds (pick one for solid-colour backgrounds).
  espresso: '#241a14',   // warm near-black brown — the house default
  forest: '#1f2d23',     // deep green — food / seasonal
  ink: '#0f172a',        // cool near-black — used for photo scrims
  // Pure black / white for full-contrast moments.
  black: '#000000',
  white: '#ffffff',
} as const

export type PaletteKey = keyof typeof PALETTE

// Explicit literal tuple of every palette key — z.enum() in design-plan.ts
// needs a readonly string-literal tuple, which Object.keys() can't provide.
// Keep in sync with PALETTE above.
export const PALETTE_KEYS = [
  'cream', 'amber', 'espresso', 'forest', 'ink', 'black', 'white',
] as const

// Font keys as a literal tuple, for the schema enum.
export const FONT_KEYS = ['display', 'serif', 'body', 'script'] as const

// Archetype ids as a literal tuple, for the schema enum.
export const ARCHETYPE_IDS = [
  'hero-product', 'simple-photo-tagline', 'dual-photo-script', 'editorial-3up',
] as const

// Colours the director may choose for a solid background fill. Const tuple
// (not PaletteKey[]) so z.enum() in design-plan.ts can consume the literals.
export const BACKGROUND_COLORS = ['espresso', 'forest', 'ink', 'black'] as const

// Colours the director may choose for text/headlines.
export const TEXT_COLORS = ['cream', 'amber', 'white', 'espresso', 'ink'] as const

// ─── Layout regions ─────────────────────────────────────────────────────────
// All fractions of canvas width/height so they scale across aspects. The
// renderer turns these into pixels; the prompt describes them so the director
// places blocks in brand-legal zones.

export const LAYOUT = {
  // Outer safe margin — text never sits closer than this to an edge.
  marginFrac: 0.055,
  // The logo lives top-centre on every post. This is the band it occupies;
  // the director must keep headline text below `logoZoneBottomFrac`.
  logo: {
    position: 'top-center' as const,
    topFrac: 0.055,        // top inset of the logo
    widthFrac: 0.24,       // logo target width as fraction of canvas width
                           // (bumped from 0.16 — QA flagged the logo as too
                           //  small/illegible at thumbnail size)
    zoneBottomFrac: 0.18,  // headlines start below this y-fraction
  },
  // Named vertical bands a text block can anchor to.
  bands: ['top', 'upper-third', 'center', 'lower-third', 'bottom'] as const,
  // Horizontal alignment options.
  align: ['left', 'center', 'right'] as const,
} as const

export type LayoutBand = (typeof LAYOUT.bands)[number]
export type LayoutAlign = (typeof LAYOUT.align)[number]

// ─── Decorative atoms ───────────────────────────────────────────────────────
// The small SVG flourishes the renderer can stamp. Names match the existing
// design-decoratives.ts library so the renderer can delegate to it. Default is
// always "none" — the typography and composition should carry the design.

export const DECORATIVE_KINDS = [
  'none',
  'hops_corner',
  'foam_burst',
  'dotted_underline',
  'vintage_frame',
  'ribbon_banner',
  'dashed_border',
  'corner_arrow',
  'starburst',
] as const

export type DecorativeKind = (typeof DECORATIVE_KINDS)[number]

// ─── Photo treatments ───────────────────────────────────────────────────────
// How a photo is placed on the canvas. The renderer implements each.

export const PHOTO_TREATMENTS = [
  'full-bleed',     // photo fills the whole canvas (with scrim for legibility)
  'inset-frame',    // photo sits inside a margin on a solid ground
  'top-half',       // photo occupies the top portion, solid ground below
  'bottom-half',    // photo occupies the bottom portion, solid ground above
  'split-vertical', // two photos stacked (dual-photo archetype)
  'strip-3up',      // three vertical photo columns (editorial archetype)
] as const

export type PhotoTreatment = (typeof PHOTO_TREATMENTS)[number]

// ─── Archetypes ─────────────────────────────────────────────────────────────
// The four recurring post structures distilled from the feed. The director
// picks one as the skeleton, then fills in the specifics. Each names the
// photo treatment and dominant typeface it tends to use — guidance, not a
// hard constraint.

export interface Archetype {
  id: string
  name: string
  description: string
  photoTreatment: PhotoTreatment
  primaryFont: keyof typeof FONTS
}

export const ARCHETYPES: Record<string, Archetype> = {
  'hero-product': {
    id: 'hero-product',
    name: 'Hero Product',
    description: 'Single hero photo, full-bleed, with a bold condensed all-caps headline (e.g. RIPE. COLD. PERFECT.). The loudest archetype — product drops and flagship moments.',
    photoTreatment: 'full-bleed',
    primaryFont: 'display',
  },
  'simple-photo-tagline': {
    id: 'simple-photo-tagline',
    name: 'Simple Photo + Tagline',
    description: 'One photo with a short tagline — condensed caps or a script accent word. The everyday workhorse for routine posts.',
    photoTreatment: 'full-bleed',
    primaryFont: 'display',
  },
  'dual-photo-script': {
    id: 'dual-photo-script',
    name: 'Dual Photo Script',
    description: 'Two photos stacked vertically with one elegant script word overlapping both (e.g. "Heavenly"). Food and indulgence moments.',
    photoTreatment: 'split-vertical',
    primaryFont: 'script',
  },
  'editorial-3up': {
    id: 'editorial-3up',
    name: 'Editorial 3-up',
    description: 'A vertical three-photo strip with a vertical date label, a refined serif headline, and a line of body copy (e.g. "A season of flavor"). The curated, magazine archetype.',
    photoTreatment: 'strip-3up',
    primaryFont: 'serif',
  },
}

export type ArchetypeId = keyof typeof ARCHETYPES

// ─── Logo lockups ───────────────────────────────────────────────────────────
// How the logo is treated. It is always top-centre; the only choice is the
// colour treatment so it reads against the chosen ground.

export const LOGO_TREATMENTS = ['auto', 'cream', 'dark'] as const
export type LogoTreatment = (typeof LOGO_TREATMENTS)[number]

// ─── Prompt serialization ────────────────────────────────────────────────────
// Compact, token-efficient description of the brand for the LLM. The layout
// director prepends this so the model only ever references legal identifiers.

export function brandDnaPromptBlock(): string {
  const fonts = Object.values(FONTS)
    .map((f) => `  - "${f.key}" — ${f.family}: ${f.role} (${f.case})`)
    .join('\n')

  const colors = (Object.keys(PALETTE) as PaletteKey[])
    .map((k) => `  - "${k}" = ${PALETTE[k]}`)
    .join('\n')

  const archetypes = Object.values(ARCHETYPES)
    .map((a) => `  - "${a.id}" (${a.name}): ${a.description}`)
    .join('\n')

  return `BRAND: District 6 — a craft brewery in Bangalore. Confident, warm, editorial. Every post: logo top-centre, dark/espresso/forest grounds or full-bleed photo, restrained decoration, one accent (amber). 4:5 portrait dominant.

FONTS (use the key, never invent a font):
${fonts}

PALETTE (use the key, never invent a colour):
${colors}
  Backgrounds skew dark & warm (espresso is the house default). Text is usually cream. Amber is the single accent — use sparingly.

ARCHETYPES (pick ONE as the skeleton):
${archetypes}

PHOTO TREATMENTS: ${PHOTO_TREATMENTS.map((t) => `"${t}"`).join(', ')}
DECORATIVES (default "none" — let typography carry it): ${DECORATIVE_KINDS.map((d) => `"${d}"`).join(', ')}
TEXT BANDS: ${LAYOUT.bands.map((b) => `"${b}"`).join(', ')}  ALIGN: ${LAYOUT.align.map((a) => `"${a}"`).join(', ')}

RULES:
- Logo is ALWAYS top-centre; keep headline text in the upper bands clear of it.
- Outer margin ~${Math.round(LAYOUT.marginFrac * 100)}% on all sides — nothing touches the edge.
- Prefer one strong typographic idea over many competing elements.
- Decoration defaults to "none". Reach for an atom only when the photo genuinely calls for one flourish.`
}

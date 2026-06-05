// The design plan — the contract between the AI Layout Director and the
// deterministic renderer.
//
// The director (an LLM) emits ONE of these per post. The renderer
// (sharp + opentype) executes it pixel-for-pixel, with no further AI in the
// loop, so text is never hallucinated and the same plan always renders the
// same image.
//
// Every enum here is derived from brand-dna.ts, so the LLM can only ever
// reference fonts, colours, archetypes, and treatments the renderer actually
// supports. All positions/sizes are fractions of the canvas (0–1) so a plan
// is resolution- and aspect-independent.
//
// Convention for the LLM path: fields the model may legitimately skip are
// `.nullable()` (Gemini structured output handles explicit null far more
// reliably than optional/missing). The renderer treats null as "use the
// brand default".

import { z } from 'zod'
import {
  ARCHETYPE_IDS,
  FONT_KEYS,
  PALETTE_KEYS,
  BACKGROUND_COLORS,
  DECORATIVE_KINDS,
  PHOTO_TREATMENTS,
  LAYOUT,
} from './brand-dna'

// ─── Leaf types ─────────────────────────────────────────────────────────────

// A focal point to preserve when the renderer crops a photo. Normalized to
// the photo's own dimensions, 0–1, origin top-left. {x:0.5,y:0.5} = centre.
const FocalPoint = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
})

// A single piece of typeset text. The renderer measures, wraps, anchors, and
// converts it to glyph paths.
const TextBlock = z.object({
  text: z.string().min(1).describe('The literal text to render. Keep headlines short (1–6 words).'),
  font: z.enum(FONT_KEYS).describe('Which brand typeface to set this in.'),
  color: z.enum(PALETTE_KEYS).describe('Brand palette key for the fill colour.'),
  // Size as a fraction of canvas HEIGHT so it scales across aspects. A bold
  // hero headline is ~0.08–0.10; body copy ~0.02–0.03.
  sizeFrac: z.number().min(0.012).max(0.16)
    .describe('Font size as a fraction of canvas height. Hero headline ≈ 0.085, sub-line ≈ 0.028, body ≈ 0.022.'),
  band: z.enum(LAYOUT.bands)
    .describe('Vertical band to anchor the block in. Keep upper-band text clear of the top-centre logo.'),
  align: z.enum(LAYOUT.align).describe('Horizontal alignment within the margins.'),
  transform: z.enum(['upper', 'title', 'as-typed'])
    .describe('Case transform applied before rendering. Condensed display is usually "upper"; script "as-typed".'),
  // Tracking (letter-spacing) as a fraction of font size; null = use the
  // font role's default from brand-dna.
  trackingFrac: z.number().min(-0.05).max(0.3).nullable()
    .describe('Letter-spacing as a fraction of font size. Null to use the font default.'),
  shadow: z.boolean()
    .describe('Drop a soft shadow behind the text. Use true when set over a busy/full-bleed photo.'),
  // Wrap width as a fraction of canvas width; null = full content width.
  maxWidthFrac: z.number().min(0.2).max(1).nullable()
    .describe('Wrap width as a fraction of canvas width. Null = full width between the margins.'),
})

export type TextBlockPlan = z.infer<typeof TextBlock>

// The amber kicker pill (e.g. "TAP TAKEOVER"). Optional brand flourish.
const Kicker = z.object({
  text: z.string().min(1).max(40),
  color: z.enum(PALETTE_KEYS).describe('Pill fill colour — usually "amber".'),
}).describe('Small all-caps label pill above the headline. Use sparingly; null when not needed.')

// ─── Background ─────────────────────────────────────────────────────────────

const Background = z.object({
  kind: z.enum(['photo', 'solid'])
    .describe('"photo" = the uploaded photo fills the ground; "solid" = a flat brand colour ground (photo placed via photo.treatment).'),
  // Only meaningful when kind === "solid".
  color: z.enum(BACKGROUND_COLORS).nullable()
    .describe('Solid ground colour key (espresso is the house default). Null when kind is "photo".'),
  // Darkening scrim laid over a photo so text stays legible.
  scrim: z.object({
    position: z.enum(['none', 'top', 'bottom', 'full']),
    strength: z.number().min(0).max(1)
      .describe('Scrim opacity 0–1. ~0.55 under a headline, up to 0.85 for dense text.'),
  }).describe('Legibility scrim over the photo. Use position "none" for clean solid grounds.'),
})

// ─── Photo placement ─────────────────────────────────────────────────────────

const Photo = z.object({
  treatment: z.enum(PHOTO_TREATMENTS)
    .describe('How the photo sits on the canvas. Must be compatible with the archetype.'),
  focal: FocalPoint.nullable()
    .describe('Point to keep in frame when cropping (0–1 of the photo). Null = centre / auto-attention.'),
})

// ─── Logo ─────────────────────────────────────────────────────────────────

const Logo = z.object({
  show: z.boolean().describe('Whether to stamp the brewery logo. Almost always true (top-centre).'),
  treatment: z.enum(['auto', 'cream', 'dark'])
    .describe('"auto" lets the renderer pick contrast; "cream" forces light logo, "dark" forces dark.'),
})

// ─── The plan ─────────────────────────────────────────────────────────────

export const DesignPlanSchema = z.object({
  archetype: z.enum(ARCHETYPE_IDS)
    .describe('The structural skeleton, chosen from the four brand archetypes.'),
  aspect: z.enum(['4:5', '1:1']).describe('Output aspect ratio. 4:5 is the brand default.'),
  rationale: z.string().max(400)
    .describe('One or two sentences on why these choices fit the photo and brand. Aids QA and debugging.'),
  background: Background,
  photo: Photo,
  textBlocks: z.array(TextBlock).min(0).max(5)
    .describe('Ordered text blocks. Usually 1 headline (+ optional sub-line). Empty only for pure-photo posts.'),
  kicker: Kicker.nullable(),
  decorative: z.enum(DECORATIVE_KINDS)
    .describe('A single decorative atom, or "none" (the default — let typography carry the design).'),
  logo: Logo,
})

export type DesignPlan = z.infer<typeof DesignPlanSchema>

// Validate + normalize an arbitrary object into a DesignPlan. Throws a
// ZodError with readable messages on failure. Use this both for LLM output
// and hand-authored fixtures so they're held to the same contract.
export function parseDesignPlan(input: unknown): DesignPlan {
  return DesignPlanSchema.parse(input)
}

import fs from 'fs'
import path from 'path'
import * as opentype from 'opentype.js'

// Namespace import (rather than default) — opentype.js v2 is CJS and the
// default import resolves to `undefined` in the Vercel lambda, which made
// `opentype.parse(...)` throw "Cannot read properties of undefined".

// Bulletproof text rendering for SVG composites. Instead of relying on
// @font-face + system font discovery (which fails on Vercel/Lambda where
// librsvg doesn't see bundled fonts via fontconfig), we parse the TTF and
// emit each glyph as an SVG <path>. Pure geometry — works everywhere.
//
// Three fonts bundled:
//   - BrewDisplay  → Anton-Regular.ttf       (bold condensed display)
//   - BrewSerif    → DMSerifDisplay-Italic.ttf (italic editorial serif)
//   - BrewBody     → Inter-Variable.ttf       (clean sans for body/handle/badge)

export type FontKey = 'display' | 'serif' | 'body'

const FONT_FILES: Record<FontKey, string> = {
  display: 'Anton-Regular.ttf',
  serif: 'DMSerifDisplay-Italic.ttf',
  body: 'Inter-Variable.ttf',
}

const _fontCache = new Map<FontKey, opentype.Font>()
const _fontStatus = new Map<FontKey, { loaded: boolean; error?: string; path?: string }>()
let _fontsTried = false

// Probe paths in order. Vercel serverless runs from /var/task; public/ files
// land there when outputFileTracingIncludes is set. Locally process.cwd() is
// the project root. We try both so the same code works in dev and prod.
function fontCandidatePaths(file: string): string[] {
  return [
    path.join(process.cwd(), 'public', 'brand', 'fonts', file),
    path.join(process.cwd(), '.next', 'standalone', 'public', 'brand', 'fonts', file),
    // Vercel-specific fallback — public files sometimes resolve relative
    // to the lambda root, not cwd
    path.join('/var/task', 'public', 'brand', 'fonts', file),
  ]
}

function loadFont(key: FontKey): opentype.Font | null {
  const cached = _fontCache.get(key)
  if (cached) return cached
  const file = FONT_FILES[key]
  const errors: string[] = []
  for (const candidate of fontCandidatePaths(file)) {
    try {
      const buf = fs.readFileSync(candidate)
      const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      _fontCache.set(key, font)
      _fontStatus.set(key, { loaded: true, path: candidate })
      console.log(`[text-to-path] loaded ${file} from ${candidate}`)
      return font
    } catch (err) {
      errors.push(`${candidate}: ${(err as Error).message}`)
    }
  }
  const msg = errors.join(' | ')
  _fontStatus.set(key, { loaded: false, error: msg })
  console.error(`[text-to-path] FAILED to load ${file} — tried ${errors.length} paths: ${msg}`)
  return null
}

// Pre-warm font cache once. Idempotent.
export function loadAllFonts(): void {
  if (_fontsTried) return
  _fontsTried = true
  for (const key of ['display', 'serif', 'body'] as const) loadFont(key)
}

// Diagnostic: what's the load status for each font?
export function getFontStatus(): Record<FontKey, { loaded: boolean; error?: string; path?: string }> {
  loadAllFonts()
  return {
    display: _fontStatus.get('display') ?? { loaded: false, error: 'never attempted' },
    serif: _fontStatus.get('serif') ?? { loaded: false, error: 'never attempted' },
    body: _fontStatus.get('body') ?? { loaded: false, error: 'never attempted' },
  }
}

// ─── Measurement ────────────────────────────────────────────────────────────

// Walk the string glyph-by-glyph via charToGlyph + advanceWidth. This
// deliberately bypasses font.getAdvanceWidth / font.stringToGlyphs because
// those paths apply GSUB features and opentype.js v2 throws on unsupported
// substitution formats — Inter-Variable in particular triggers
// "substitutionType : 62 lookupType: 6 - substFormat: 2 is not yet supported".
// We lose ligatures and contextual swashes, which is fine for short headlines.
function measureLine(font: opentype.Font, text: string, fontSize: number): number {
  const scale = fontSize / font.unitsPerEm
  let w = 0
  for (const ch of text) {
    const g = font.charToGlyph(ch)
    w += (g.advanceWidth ?? 0) * scale
  }
  return w
}

/**
 * Measure the width in pixels of `text` rendered in `font` at `fontSize`.
 * Used by the wrap function below.
 */
export function measureText(text: string, font: FontKey, fontSize: number): number {
  const f = loadFont(font)
  if (!f) return text.length * fontSize * 0.55  // rough fallback
  return measureLine(f, text, fontSize)
}

/**
 * Greedy word-wrap that fits text into maxWidth pixels at the given fontSize.
 * Returns an array of lines. Always returns at least one line (even if the
 * single longest word overflows — better than dropping content).
 */
export function wrapTextToWidth(
  text: string,
  font: FontKey,
  fontSize: number,
  maxWidth: number,
): string[] {
  const words = text.trim().split(/\s+/)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (measureText(candidate, font, fontSize) <= maxWidth) {
      current = candidate
    } else {
      if (current) lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : [text]
}

// ─── Rendering ──────────────────────────────────────────────────────────────

export interface RenderTextOptions {
  text: string
  font: FontKey
  fontSize: number
  x: number                    // baseline x (will be adjusted by anchor)
  y: number                    // baseline y of the first line
  color?: string
  opacity?: number
  letterSpacing?: number       // additional spacing in pixels
  anchor?: 'start' | 'middle' | 'end'
  // Drop shadow — set offset and blur to enable
  shadow?: {
    offsetX: number
    offsetY: number
    blur: number
    color: string
    opacity: number
  }
  // Multi-line: if provided, renders each line stacked.
  lines?: string[]
  lineHeight?: number          // multiplier on fontSize (default 1.05)
}

export interface RenderedText {
  svg: string                  // the <path> (and optional <filter>) elements
  width: number                // longest line width
  totalHeight: number          // line count * lineHeight * fontSize
}

/**
 * Convert text to SVG path geometry. Returns a string of SVG markup ready
 * to embed inside an <svg> document. If the font failed to load, returns
 * an empty SVG fragment (caller should fall back to a <text> element OR
 * just accept that nothing renders).
 */
export function renderText(opts: RenderTextOptions): RenderedText {
  const f = loadFont(opts.font)
  if (!f) {
    return { svg: '', width: 0, totalHeight: 0 }
  }

  const lines = opts.lines ?? [opts.text]
  const lineHeight = opts.lineHeight ?? 1.05
  const color = opts.color ?? '#ffffff'
  const opacity = opts.opacity ?? 1
  const ls = opts.letterSpacing ?? 0

  // Per-line widths
  const widths = lines.map((line) => measureText(line, opts.font, opts.fontSize) + ls * Math.max(0, line.length - 1))
  const maxWidth = Math.max(...widths)

  // Shadow filter — unique id per call to avoid clashes when multiple
  // renderText() outputs land in the same SVG.
  let filterDef = ''
  let filterAttr = ''
  if (opts.shadow) {
    const id = `shadow_${Math.random().toString(36).slice(2, 8)}`
    filterDef = `
      <filter id="${id}" x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="${opts.shadow.blur}"/>
        <feOffset dx="${opts.shadow.offsetX}" dy="${opts.shadow.offsetY}" result="offsetblur"/>
        <feComponentTransfer><feFuncA type="linear" slope="${opts.shadow.opacity}"/></feComponentTransfer>
        <feMerge>
          <feMergeNode/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>`
    filterAttr = ` filter="url(#${id})"`
  }

  // Build a path per line, anchored as requested. We always go glyph-by-glyph
  // (rather than font.getPath(line, ...)) because font.getPath runs the text
  // through stringToGlyphs which applies GSUB features — and opentype.js
  // throws on unsupported GSUB substitution formats present in Inter / DM
  // Serif. charToGlyph + glyph.getPath skips that pipeline entirely.
  const scale = opts.fontSize / f.unitsPerEm
  const paths: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const w = widths[i]
    let x0 = opts.x
    if (opts.anchor === 'middle') x0 = opts.x - w / 2
    else if (opts.anchor === 'end') x0 = opts.x - w
    const y0 = opts.y + i * opts.fontSize * lineHeight

    let cursor = x0
    const subpaths: string[] = []
    for (const ch of line) {
      const g = f.charToGlyph(ch)
      const pathObj = g.getPath(cursor, y0, opts.fontSize)
      const d = pathObj.toPathData(2)
      if (d) subpaths.push(d)
      cursor += (g.advanceWidth ?? 0) * scale + ls
    }
    if (subpaths.length > 0) {
      paths.push(`<path d="${subpaths.join(' ')}" fill="${color}" opacity="${opacity}"/>`)
    }
  }

  const inner = paths.join('')
  const grouped = `<g${filterAttr}>${inner}</g>`
  const svg = filterDef + grouped

  return {
    svg,
    width: maxWidth,
    totalHeight: lines.length * opts.fontSize * lineHeight,
  }
}

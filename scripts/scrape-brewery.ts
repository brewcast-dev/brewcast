/**
 * Scrapes a brewery website and upserts the result into the brewery table.
 * Usage: npx ts-node --project tsconfig.scripts.json scripts/scrape-brewery.ts <url>
 * Requires: npx playwright install chromium  (first run only)
 */

import * as fs from 'fs'
import * as path from 'path'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

// Load .env.local so the script works without a shell-level env setup
function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const key = m[1]
    const val = m[2].replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnvLocal()

const targetUrl = process.argv[2]
if (!targetUrl) {
  console.error('Usage: npx ts-node --project tsconfig.scripts.json scripts/scrape-brewery.ts <brewery-url>')
  process.exit(1)
}

interface ScrapedBrewery {
  name: string | null
  website_url: string
  tagline: string | null
  about: string | null
  beer_styles: string[] | null
  brand_colors: Record<string, string> | null
  tone_of_voice: string | null
  logo_url: string | null
  ig_handle: string | null
}

async function scrape(breweryUrl: string): Promise<ScrapedBrewery> {
  const browser = await chromium.launch({ headless: true })
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; BrewCast-Scraper/1.0)',
    })
    const page = await ctx.newPage()
    const origin = new URL(breweryUrl).origin

    console.log('  → Loading homepage...')
    await page.goto(breweryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    // ── Basic metadata ──────────────────────────────────────────────────────
    const name = await page.evaluate(() =>
      document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')
      ?? document.querySelector('h1')?.textContent?.trim()
      ?? document.title.split(/[|\-–]/)[0].trim()
    )

    const tagline = await page.evaluate(() =>
      document.querySelector('meta[property="og:description"]')?.getAttribute('content')
      ?? document.querySelector('meta[name="description"]')?.getAttribute('content')
      ?? null
    )

    const logoUrl = await page.evaluate(() => {
      const og = document.querySelector('meta[property="og:image"]')?.getAttribute('content')
      if (og) return og.startsWith('http') ? og : new URL(og, location.href).href
      const img = document.querySelector<HTMLImageElement>(
        'img[alt*="logo" i], img[class*="logo" i], header img, nav img'
      )
      return img?.src ?? null
    })

    const igHandle = await page.evaluate(() => {
      const blocked = new Set(['p', 'reel', 'explore', 'accounts', 'stories'])
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="instagram.com"]'))) {
        const m = a.href.match(/instagram\.com\/([\w.]+)\/?/)
        if (m?.[1] && !blocked.has(m[1])) return `@${m[1]}`
      }
      return null
    })

    // Brand colors from header/nav background
    const brandColors = await page.evaluate((): Record<string, string> | null => {
      for (const sel of ['header', 'nav', '.header', '#header', 'body']) {
        const el = document.querySelector(sel)
        if (!el) continue
        const s = window.getComputedStyle(el)
        const bg = s.backgroundColor
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          return { primary: bg, text: s.color }
        }
      }
      return null
    })

    // ── About text ───────────────────────────────────────────────────────────
    let about: string | null = null
    const aboutHref = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a')).find(a =>
        /about|our story|brewery|who we are/i.test(a.textContent ?? '')
      )?.href ?? null
    )
    if (aboutHref?.startsWith(origin) && aboutHref !== breweryUrl) {
      console.log('  → Loading about page...')
      try {
        await page.goto(aboutHref, { waitUntil: 'domcontentloaded', timeout: 20_000 })
        about = await page.evaluate(() =>
          document.querySelector('main, article, [class*="about" i], [class*="story" i]')
            ?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 2000) ?? null
        )
        await page.goto(breweryUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      } catch (_e) { /* skip — about page unavailable */ }
    }
    // Fallback: on-page about section
    if (!about) {
      about = await page.evaluate(() =>
        document.querySelector('[class*="about" i], [id*="about" i], [class*="story" i]')
          ?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 2000) ?? null
      )
    }

    // ── Beer styles ──────────────────────────────────────────────────────────
    let beerStyles: string[] | null = null
    const beerHref = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a')).find(a =>
        /\bbeers?\b|menu|tap list|brews?|our beers/i.test(a.textContent ?? '')
      )?.href ?? null
    )
    if (beerHref?.startsWith(origin) && beerHref !== breweryUrl) {
      console.log('  → Loading beers page...')
      try {
        await page.goto(beerHref, { waitUntil: 'domcontentloaded', timeout: 20_000 })
        const raw = await page.evaluate(() =>
          Array.from(document.querySelectorAll('h2, h3, h4, [class*="beer" i], [class*="brew" i]'))
            .map(el => el.textContent?.trim() ?? '')
            .filter(t => t.length > 1 && t.length < 80)
        )
        const unique = Array.from(new Set(raw)).slice(0, 30)
        if (unique.length > 0) beerStyles = unique
      } catch (_e) { /* skip — beers page unavailable */ }
    }

    return {
      name: name ?? null,
      website_url: breweryUrl,
      tagline: tagline?.slice(0, 300) ?? null,
      about,
      beer_styles: beerStyles,
      brand_colors: brandColors,
      tone_of_voice: null,
      logo_url: logoUrl ?? null,
      ig_handle: igHandle ?? null,
    }
  } finally {
    await browser.close()
  }
}

async function main() {
  console.log(`Scraping: ${targetUrl}\n`)

  const data = await scrape(targetUrl)

  console.log('\nExtracted:')
  console.log(JSON.stringify(data, null, 2))

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceKey) {
    console.log('\nMissing env vars — dry run only (no upsert).')
    console.log('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to persist data.')
    return
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // Single-tenant: one brewery row. Update if it exists, insert otherwise.
  const { data: existing, error: fetchErr } = await supabase
    .from('brewery')
    .select('id')
    .limit(1)
    .maybeSingle()

  if (fetchErr) throw new Error(`Failed to query brewery table: ${fetchErr.message}`)

  if (existing?.id) {
    const { error } = await supabase.from('brewery').update(data).eq('id', existing.id)
    if (error) throw new Error(`Update failed: ${error.message}`)
    console.log(`\nUpdated brewery row (id: ${existing.id})`)
  } else {
    const { error } = await supabase.from('brewery').insert(data)
    if (error) throw new Error(`Insert failed: ${error.message}`)
    console.log('\nInserted new brewery row')
  }

  console.log('Done.')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

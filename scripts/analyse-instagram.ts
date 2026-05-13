/**
 * Analyses an Apify Instagram dataset and upserts style insights into the brewery table.
 * Usage: npx ts-node --project tsconfig.scripts.json scripts/analyse-instagram.ts <path-to-json>
 * Requires: GOOGLE_GENERATIVE_AI_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import * as fs from 'fs'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'

// ── Env loader ────────────────────────────────────────────────────────────────

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const val = m[2].replace(/^["']|["']$/g, '')
    if (!process.env[m[1]]) process.env[m[1]] = val
  }
}
loadEnvLocal()

// ── Types ─────────────────────────────────────────────────────────────────────

// Apify Instagram Post Scraper output shape (only fields we use)
interface ApifyPost {
  caption?: string | null
  likesCount?: number | null
  commentsCount?: number | null
  timestamp?: string | null
  mediaType?: string | null
  hashtags?: string[] | null
  ownerUsername?: string | null
  videoViewCount?: number | null
}

interface InspirationCaption {
  caption: string
  likes: number
  comments: number
  mediaType: string
  timestamp: string
}

interface Insights {
  totalPosts: number
  postsWithCaption: number
  postsPerWeek: number
  avgCaptionLength: number
  avgEmojis: number
  emojiHeavyPct: number
  avgExclamations: number
  avgHashtagsPerPost: number
  hashtagPlacement: string
  topHashtags: Array<[string, number]>
  topThemes: Array<[string, number]>
  mediaPerformance: Array<{ type: string; count: number; avgLikes: number }>
  topCaptions: InspirationCaption[]
  overallAvgLikes: number
  overallAvgComments: number
  igHandle: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const THEMES: Record<string, string[]> = {
  'New Release':          ['new', 'launch', 'introducing', 'now available', 'just dropped', 'debut', 'releasing', 'try our'],
  'Events':               ['event', 'live', 'tonight', 'this weekend', 'join us', 'happening', 'party', 'night out', 'friday', 'saturday', 'sunday'],
  'Seasonal / Limited':   ['season', 'limited', 'special edition', 'festival', 'winter', 'summer', 'monsoon', 'limited batch'],
  'Food & Pairing':       ['food', 'pair', 'snack', 'bite', 'kitchen', 'menu', 'eat', 'meal', 'taco', 'pizza', 'cheese'],
  'Craft & Process':      ['brew', 'craft', 'recipe', 'hops', 'malt', 'barrel', 'ferment', 'aged', 'ingredient', 'brewmaster'],
  'Taproom Vibes':        ['taproom', 'visit us', 'come by', 'open', 'pint', 'glass', 'cheers', 'bar', 'doors open', 'on tap'],
  'Community':            ['team', 'family', 'crew', 'collab', 'community', 'together', 'friends', 'staff', 'people'],
  'Awards & Recognition': ['award', 'win', 'winner', 'best', 'top rated', 'feature', 'accolade', 'recognition'],
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function normalizeMediaType(raw: string | null | undefined): string {
  const t = (raw ?? '').toLowerCase()
  if (t.includes('video')) return 'Video'
  if (t.includes('sidecar') || t.includes('carousel') || t.includes('album')) return 'Carousel'
  return 'Image'
}

function countEmojis(text: string): number {
  // \p{Extended_Pictographic} covers all pictographic emoji (avoids matching plain digits)
  return Array.from(text.matchAll(/\p{Extended_Pictographic}/gu)).length
}

function countExclamations(text: string): number {
  return (text.match(/!/g) ?? []).length
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length
}

function topN(items: string[], n: number): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
}

function hashtagsFromPost(post: ApifyPost): string[] {
  if (post.hashtags && post.hashtags.length > 0) {
    return post.hashtags.map(h => h.toLowerCase().replace(/^#/, '').trim()).filter(Boolean)
  }
  // Fallback: extract from caption text
  return Array.from((post.caption ?? '').matchAll(/#(\w+)/g)).map(m => m[1].toLowerCase())
}

// ── Analysis ──────────────────────────────────────────────────────────────────

function analyse(posts: ApifyPost[]): Insights {
  const withCaption = posts.filter(p => p.caption && p.caption.trim().length > 3)

  // Caption metrics
  const captionLengths = withCaption.map(p => p.caption!.length)
  const avgCaptionLength = Math.round(avg(captionLengths))

  const emojiCounts = withCaption.map(p => countEmojis(p.caption!))
  const avgEmojis = Math.round(avg(emojiCounts) * 10) / 10
  const emojiHeavyPct = withCaption.length > 0
    ? Math.round((emojiCounts.filter(c => c > 0).length / withCaption.length) * 100)
    : 0

  const exclamCounts = withCaption.map(p => countExclamations(p.caption!))
  const avgExclamations = Math.round(avg(exclamCounts) * 10) / 10

  // Hashtag analysis
  const allHashtags = posts.flatMap(p => hashtagsFromPost(p))
  const hashtagCounts = posts.map(p => hashtagsFromPost(p).length)
  const avgHashtagsPerPost = Math.round(avg(hashtagCounts))

  // Where hashtags appear (first half vs second half of caption)
  let trailingCount = 0
  for (const p of withCaption) {
    const cap = p.caption!
    const firstTagPos = cap.indexOf('#')
    if (firstTagPos > cap.length / 2) trailingCount++
  }
  const hashtagPlacement = trailingCount > withCaption.length * 0.6
    ? 'clustered at the end'
    : 'mixed throughout caption'

  // Top hashtags
  const topHashtags = topN(allHashtags, 20)

  // Content themes
  const themeCounts = Object.entries(THEMES).map(([theme, keywords]) => {
    const count = withCaption.filter(p =>
      keywords.some(kw => p.caption!.toLowerCase().includes(kw))
    ).length
    return [theme, count] as [string, number]
  }).sort((a, b) => b[1] - a[1]).filter(([, c]) => c > 0)

  // Media type performance
  const typeGroups = new Map<string, number[]>()
  for (const p of posts) {
    const type = normalizeMediaType(p.mediaType)
    if (!typeGroups.has(type)) typeGroups.set(type, [])
    typeGroups.get(type)!.push(p.likesCount ?? 0)
  }
  const mediaPerformance = Array.from(typeGroups.entries())
    .map(([type, likes]) => ({ type, count: likes.length, avgLikes: Math.round(avg(likes)) }))
    .sort((a, b) => b.avgLikes - a.avgLikes)

  // Posting frequency
  const timestamps = posts
    .map(p => (p.timestamp ? new Date(p.timestamp).getTime() : null))
    .filter((t): t is number => t !== null && !isNaN(t))
    .sort((a, b) => a - b)
  let postsPerWeek = 0
  if (timestamps.length > 1) {
    const weeksCovered = (timestamps[timestamps.length - 1] - timestamps[0]) / (7 * 24 * 60 * 60 * 1000)
    postsPerWeek = weeksCovered > 0 ? Math.round((posts.length / weeksCovered) * 10) / 10 : 0
  }

  // Top 5 captions by likes
  const topCaptions: InspirationCaption[] = [...posts]
    .filter(p => p.caption && p.caption.trim().length > 10 && (p.likesCount ?? 0) > 0)
    .sort((a, b) => (b.likesCount ?? 0) - (a.likesCount ?? 0))
    .slice(0, 5)
    .map(p => ({
      caption: p.caption!.trim(),
      likes: p.likesCount ?? 0,
      comments: p.commentsCount ?? 0,
      mediaType: normalizeMediaType(p.mediaType),
      timestamp: p.timestamp ?? '',
    }))

  const overallAvgLikes = Math.round(avg(posts.map(p => p.likesCount ?? 0)))
  const overallAvgComments = Math.round(avg(posts.map(p => p.commentsCount ?? 0)))

  // Derive IG handle from data
  const rawHandle = posts.find(p => p.ownerUsername)?.ownerUsername ?? null
  const igHandle = rawHandle ? `@${rawHandle}` : '@district6blr'

  return {
    totalPosts: posts.length,
    postsWithCaption: withCaption.length,
    postsPerWeek,
    avgCaptionLength,
    avgEmojis,
    emojiHeavyPct,
    avgExclamations,
    avgHashtagsPerPost,
    hashtagPlacement,
    topHashtags,
    topThemes: themeCounts,
    mediaPerformance,
    topCaptions,
    overallAvgLikes,
    overallAvgComments,
    igHandle,
  }
}

// ── Gemini ────────────────────────────────────────────────────────────────────

async function generateContentStyle(ins: Insights): Promise<string> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set')

  const hashtagStr = ins.topHashtags
    .slice(0, 15)
    .map(([tag, n]) => `#${tag}(${n})`)
    .join('  ')

  const themeStr = ins.topThemes
    .slice(0, 6)
    .map(([theme, n]) => `${theme}: ${n} posts`)
    .join('   ')

  const mediaStr = ins.mediaPerformance
    .map(m => `${m.type}: avg ${m.avgLikes.toLocaleString()} likes (${m.count} posts)`)
    .join('   ')

  const captionExamples = ins.topCaptions
    .map((c, i) => {
      const preview = c.caption.length > 350 ? c.caption.slice(0, 350) + '…' : c.caption
      return `${i + 1}. [${c.likes.toLocaleString()} likes · ${c.mediaType}]\n"${preview}"`
    })
    .join('\n\n')

  const prompt = `You are a brand strategist. Using the Instagram analytics below for ${ins.igHandle} — a craft brewery in Bangalore, India — write a 200-word content_style guide that an AI caption generator will use to write new posts in this brewery's exact voice.

=== ANALYTICS (${ins.totalPosts} posts) ===
Posting frequency : ${ins.postsPerWeek} posts/week
Avg likes/post    : ${ins.overallAvgLikes}   Avg comments: ${ins.overallAvgComments}

CAPTION METRICS:
  Length            : avg ${ins.avgCaptionLength} characters
  Emoji usage       : ${ins.emojiHeavyPct}% of posts contain emojis (avg ${ins.avgEmojis} per post)
  Exclamation marks : avg ${ins.avgExclamations} per post
  Hashtags          : avg ${ins.avgHashtagsPerPost} per post, ${ins.hashtagPlacement}

TOP 15 HASHTAGS: ${hashtagStr}

TOP CONTENT THEMES: ${themeStr}

MEDIA PERFORMANCE (best → worst): ${mediaStr}

TOP 5 HIGHEST-ENGAGEMENT CAPTIONS:
${captionExamples}
=== END ===

Write in plain prose — no bullet points, no headers. Cover: overall voice and personality, tone (casual/formal, humorous/sincere, local pride), emoji style and density, hashtag strategy (how many, where placed, which categories), ideal caption length, content angles that drive the most engagement, any recurring phrases or sign-offs, and what makes this brewery's Instagram unmistakably theirs. The guide must be actionable for an AI generating new captions. Exactly 200 words.`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 700, temperature: 0.7 },
      }),
    },
  )

  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`)

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    error?: { message: string }
  }

  if (json.error) throw new Error(`Gemini error: ${json.error.message}`)

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Gemini returned empty content')
  return text.trim()
}

// ── Print helpers ─────────────────────────────────────────────────────────────

function printInsights(ins: Insights): void {
  console.log(`\n📊  Caption Metrics  (${ins.postsWithCaption}/${ins.totalPosts} posts have captions)`)
  console.log(`    Avg length      : ${ins.avgCaptionLength} chars`)
  console.log(`    Emoji usage     : ${ins.emojiHeavyPct}% of posts  (avg ${ins.avgEmojis}/post)`)
  console.log(`    Exclamations    : avg ${ins.avgExclamations}/post`)
  console.log(`    Hashtags        : avg ${ins.avgHashtagsPerPost}/post, ${ins.hashtagPlacement}`)
  console.log(`    Posting freq    : ${ins.postsPerWeek} posts/week`)
  console.log(`    Avg engagement  : ${ins.overallAvgLikes} likes, ${ins.overallAvgComments} comments`)

  console.log(`\n🏷️   Top ${ins.topHashtags.length} Hashtags`)
  const tagLine = ins.topHashtags.map(([tag, n]) => `#${tag}(${n})`).join('  ')
  // Wrap at ~100 chars
  const words = tagLine.split('  ')
  let line = '    '
  for (const w of words) {
    if (line.length + w.length > 104) { console.log(line); line = '    ' }
    line += w + '  '
  }
  if (line.trim()) console.log(line)

  console.log('\n🎭  Content Themes')
  for (const [theme, count] of ins.topThemes) {
    const bar = '█'.repeat(Math.round(count / ins.totalPosts * 40))
    console.log(`    ${theme.padEnd(24)} ${String(count).padStart(3)} posts  ${bar}`)
  }

  console.log('\n📱  Media Type Performance')
  for (const m of ins.mediaPerformance) {
    console.log(`    ${m.type.padEnd(10)} avg ${String(m.avgLikes).padStart(5)} likes   (${m.count} posts)`)
  }

  console.log('\n⭐  Top 5 Posts by Likes')
  for (const [i, c] of ins.topCaptions.entries()) {
    const preview = c.caption.slice(0, 90).replace(/\n+/g, ' ')
    console.log(`    [${i + 1}] ${c.likes.toLocaleString().padStart(6)} likes · ${c.mediaType} — "${preview}…"`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: npx ts-node --project tsconfig.scripts.json scripts/analyse-instagram.ts <path-to-json>')
    process.exit(1)
  }

  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`)
    process.exit(1)
  }

  console.log(`Reading ${resolved} …`)
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown

  // Apify output is either a top-level array or { items: [...] }
  let posts: ApifyPost[]
  if (Array.isArray(raw)) {
    posts = raw as ApifyPost[]
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).items)) {
    posts = (raw as { items: ApifyPost[] }).items
  } else {
    console.error('Unexpected JSON shape — expected an array or { items: [...] }')
    process.exit(1)
  }

  if (posts.length === 0) {
    console.error('No posts found in JSON file')
    process.exit(1)
  }

  console.log(`Analysing ${posts.length} posts from ${posts.find(p => p.ownerUsername)?.ownerUsername ?? 'unknown'}…`)

  const ins = analyse(posts)
  printInsights(ins)

  // ── Gemini content style ──────────────────────────────────────────────────
  console.log('\n🤖  Generating content style summary via Gemini…')
  const contentStyle = await generateContentStyle(ins)

  console.log('\n─────────────────────────── Content Style ────────────────────────────')
  console.log(contentStyle)
  console.log('──────────────────────────────────────────────────────────────────────')

  // ── Supabase upsert ───────────────────────────────────────────────────────
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceKey) {
    console.log('\nMissing Supabase env vars — dry run complete (nothing written to DB).')
    console.log('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to persist.')
    return
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  const { data: existing, error: fetchErr } = await supabase
    .from('brewery')
    .select('id')
    .limit(1)
    .maybeSingle()

  if (fetchErr) throw new Error(`Supabase query failed: ${fetchErr.message}`)

  const payload = {
    content_style: contentStyle,
    inspiration_captions: ins.topCaptions,
  }

  if (existing?.id) {
    const { error } = await supabase.from('brewery').update(payload).eq('id', existing.id)
    if (error) throw new Error(`Update failed: ${error.message}`)
    console.log(`\n✅  content_style saved`)
    console.log(`✅  inspiration_captions saved  (${ins.topCaptions.length} examples)`)
    console.log(`    Row: ${existing.id}`)
  } else {
    const { error } = await supabase.from('brewery').insert(payload)
    if (error) throw new Error(`Insert failed: ${error.message}`)
    console.log('\n✅  content_style + inspiration_captions saved (new brewery row)')
  }

  console.log('\nDone.')
}

main().catch((err: unknown) => {
  console.error('\n❌ ', err instanceof Error ? err.message : String(err))
  process.exit(1)
})

// AI usage + cost tracking. Every LLM call records one row in `ai_usage`
// (see migration 010) so the app knows its token burn and rupee cost, and can
// warn before the prepaid Gemini balance runs out.
//
// Design notes:
//  - The Gemini key is PREPAID — Google can never bill past the loaded balance.
//    So this is for VISIBILITY + an early warning before calls start failing,
//    not to prevent an overage charge (impossible on prepaid).
//  - Mode is TRACK + WARN, never block. recordAiUsage() is best-effort and
//    swallows its own errors so a logging hiccup can never break the pipeline.
//  - Pricing/forex live in editable constants below — confirm rates against
//    https://ai.google.dev/gemini-api/docs/pricing and adjust as Google changes
//    them. Only Gemini ("google") spend counts toward the prepaid budget; Groq
//    and Mistral run on separate accounts and are logged with cost 0.

import { createAdminClient } from '../supabase'

// ─── Tunables (overridable via env) ──────────────────────────────────────────

// USD → INR. Set USD_INR_RATE in .env.local to keep rupee costs accurate.
const USD_INR_RATE = Number(process.env.USD_INR_RATE ?? '85')

// The prepaid deposit you want to stay within (rupees).
export const AI_BUDGET_INR = Number(process.env.AI_BUDGET_INR ?? '1000')

// Warn once spend crosses this fraction of the budget.
export const AI_BUDGET_WARN_PCT = Number(process.env.AI_BUDGET_WARN_PCT ?? '0.8')

// Optional ISO date marking when the current prepaid balance was loaded. The
// budget status sums Gemini spend since this instant (prepaid balances don't
// reset monthly). Unset = since the beginning of the ledger.
const AI_BUDGET_SINCE = process.env.AI_BUDGET_SINCE || null

// ─── Pricing table (USD per 1,000,000 tokens) ────────────────────────────────
// Keys are matched as PREFIXES of the normalized model id, longest-first, so a
// versioned id like "gemini-2.5-flash-002" still resolves. Verify against the
// Gemini pricing page; values current as of 2026-06.

interface Rates {
  input: number        // standard (uncached) input
  cachedInput: number  // cached input (much cheaper)
  output: number
}

const PRICING: Record<string, Rates> = {
  // Order doesn't matter — we explicitly pick the longest matching prefix.
  'gemini-3-pro': { input: 2.0, cachedInput: 0.5, output: 12.0 },
  'gemini-2.5-pro': { input: 1.25, cachedInput: 0.31, output: 10.0 },
  'gemini-2.5-flash-lite': { input: 0.1, cachedInput: 0.025, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, cachedInput: 0.075, output: 2.5 },
}

// Sorted longest-first so "gemini-2.5-flash-lite" wins over "gemini-2.5-flash".
const PRICING_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length)

// ─── Types ──────────────────────────────────────────────────────────────────

// Shape we read off an AI SDK v6 generate* result. Kept structural so callers
// can pass the result object directly without importing SDK types.
export interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
}

export interface GenResultLike {
  usage?: UsageLike
  response?: { modelId?: string }
}

export type Provider = 'google' | 'groq' | 'mistral' | 'unknown'

// ─── Helpers ──────────────────────────────────────────────────────────────

export function normalizeModel(id: string): string {
  return id.replace(/^models\//, '').trim().toLowerCase()
}

function priceFor(modelId: string): Rates | null {
  const m = normalizeModel(modelId)
  for (const key of PRICING_KEYS) {
    if (m.startsWith(key)) return PRICING[key]
  }
  return null
}

function inferProvider(modelId: string): Provider {
  const m = normalizeModel(modelId)
  if (m.startsWith('gemini') || m.startsWith('text-embedding')) return 'google'
  if (m.includes('llama') || m.includes('mixtral') || m.includes('gemma')) return 'groq'
  if (m.includes('mistral') || m.includes('pixtral')) return 'mistral'
  return 'unknown'
}

/**
 * Compute the USD + INR cost of one call. Cached input tokens are billed at the
 * cheaper cached rate; the rest of the input at the standard rate. Returns
 * cost 0 (hasPricing=false) for models we don't price (Groq/Mistral).
 */
export function costFor(modelId: string, usage: UsageLike): { usd: number; inr: number; hasPricing: boolean } {
  const rates = priceFor(modelId)
  const input = usage.inputTokens ?? 0
  const cached = Math.min(usage.cachedInputTokens ?? 0, input)
  const output = usage.outputTokens ?? 0
  if (!rates) return { usd: 0, inr: 0, hasPricing: false }
  const billedInput = Math.max(0, input - cached)
  const usd =
    (billedInput / 1e6) * rates.input +
    (cached / 1e6) * rates.cachedInput +
    (output / 1e6) * rates.output
  return { usd, inr: usd * USD_INR_RATE, hasPricing: true }
}

// ─── Recording ──────────────────────────────────────────────────────────────

/**
 * Append one usage row. Best-effort: never throws, so a logging failure can't
 * break a generation. Pass the AI SDK result plus a feature label; pass an
 * explicit `model`/`provider` when you know them (more reliable than the
 * response's modelId, which may be versioned).
 *
 * Awaited by callers (the insert is fast) so the row is flushed before the
 * serverless request returns.
 */
export async function recordAiUsage(
  result: GenResultLike,
  opts: { feature: string; provider?: Provider; model?: string; userId?: string | null },
): Promise<void> {
  try {
    const usage = result.usage ?? {}
    const model = normalizeModel(opts.model ?? result.response?.modelId ?? 'unknown')
    const provider = opts.provider ?? inferProvider(model)
    const input = usage.inputTokens ?? 0
    const output = usage.outputTokens ?? 0
    const cached = Math.min(usage.cachedInputTokens ?? 0, input)
    const total = usage.totalTokens ?? input + output
    const { usd, inr } = costFor(model, usage)

    const supabase = createAdminClient()
    const { error } = await supabase.from('ai_usage').insert({
      user_id: opts.userId ?? null,
      provider,
      model,
      feature: opts.feature,
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: cached,
      total_tokens: total,
      cost_usd: Number(usd.toFixed(6)),
      cost_inr: Number(inr.toFixed(4)),
    })
    if (error) console.warn('[usage] insert failed:', error.message)
  } catch (err) {
    console.warn('[usage] recordAiUsage error:', (err as Error).message)
  }
}

// ─── Reporting ──────────────────────────────────────────────────────────────

export interface SpendSummary {
  windowStart: string | null
  calls: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  totalTokens: number
  costUsd: number
  costInr: number
}

function emptySummary(windowStart: string | null): SpendSummary {
  return {
    windowStart,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    costInr: 0,
  }
}

/**
 * Sum usage rows. `sinceISO` null = all time. Optionally filter by provider
 * (e.g. 'google' for the prepaid budget) or user.
 */
export async function getSpendSince(
  sinceISO: string | null,
  opts?: { provider?: Provider; userId?: string },
): Promise<SpendSummary> {
  const supabase = createAdminClient()
  let q = supabase
    .from('ai_usage')
    .select('input_tokens,output_tokens,cached_input_tokens,total_tokens,cost_usd,cost_inr')
  if (sinceISO) q = q.gte('created_at', sinceISO)
  if (opts?.provider) q = q.eq('provider', opts.provider)
  if (opts?.userId) q = q.eq('user_id', opts.userId)

  const { data, error } = await q
  if (error) throw new Error(`ai_usage query failed: ${error.message}`)

  const rows = (data ?? []) as Array<{
    input_tokens: number
    output_tokens: number
    cached_input_tokens: number
    total_tokens: number
    cost_usd: number
    cost_inr: number
  }>

  const sum = emptySummary(sinceISO)
  sum.calls = rows.length
  for (const r of rows) {
    sum.inputTokens += Number(r.input_tokens) || 0
    sum.outputTokens += Number(r.output_tokens) || 0
    sum.cachedInputTokens += Number(r.cached_input_tokens) || 0
    sum.totalTokens += Number(r.total_tokens) || 0
    sum.costUsd += Number(r.cost_usd) || 0
    sum.costInr += Number(r.cost_inr) || 0
  }
  sum.costUsd = Number(sum.costUsd.toFixed(6))
  sum.costInr = Number(sum.costInr.toFixed(4))
  return sum
}

function monthStartISO(): string {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

/** Spend so far this calendar month (UTC). All providers unless filtered. */
export function getMonthToDateSpend(opts?: { provider?: Provider; userId?: string }): Promise<SpendSummary> {
  return getSpendSince(monthStartISO(), opts)
}

export interface BudgetStatus {
  capInr: number
  spentInr: number
  remainingInr: number
  pctUsed: number          // 0..1+
  warnThresholdPct: number
  level: 'ok' | 'warn' | 'over'
  since: string | null     // window the spend is summed over
}

/**
 * Budget status against the prepaid Gemini deposit. Sums GOOGLE spend since the
 * deposit was loaded (AI_BUDGET_SINCE) — prepaid balances don't reset monthly —
 * and grades it ok / warn / over. This NEVER blocks anything; callers decide
 * what to do with the level (we surface a warning).
 */
export async function getBudgetStatus(): Promise<BudgetStatus> {
  const spend = await getSpendSince(AI_BUDGET_SINCE, { provider: 'google' })
  const spentInr = spend.costInr
  const pctUsed = AI_BUDGET_INR > 0 ? spentInr / AI_BUDGET_INR : 0
  const level: BudgetStatus['level'] = pctUsed >= 1 ? 'over' : pctUsed >= AI_BUDGET_WARN_PCT ? 'warn' : 'ok'
  return {
    capInr: AI_BUDGET_INR,
    spentInr: Number(spentInr.toFixed(4)),
    remainingInr: Number(Math.max(0, AI_BUDGET_INR - spentInr).toFixed(4)),
    pctUsed: Number(pctUsed.toFixed(4)),
    warnThresholdPct: AI_BUDGET_WARN_PCT,
    level,
    since: AI_BUDGET_SINCE,
  }
}

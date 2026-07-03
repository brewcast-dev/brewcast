import { createAdminClient } from './supabase'

export interface BreweryConfig {
  id: string
  user_id: string
  brewery_name: string | null
  brand_context: string | null
  google_api_key: string | null
  groq_api_key: string | null
  mistral_api_key: string | null
  meta_app_id: string | null
  meta_app_secret: string | null
  meta_ig_user_id: string | null
  meta_access_token: string | null
  meta_fb_page_id: string | null
  meta_ad_account_id: string | null
  meta_ads_token: string | null
  logo_url: string | null
  logo_path: string | null
}

/** Fully resolved config with env-var fallbacks applied. */
export interface ResolvedConfig {
  breweryName: string
  brandContext: string | null
  googleApiKey: string
  groqApiKey: string
  mistralApiKey: string
  metaIgUserId: string
  metaAccessToken: string
  metaFbPageId: string | null
  metaAdAccountId: string | null
  metaAdsToken: string | null
  logoUrl: string | null
}

export async function getUserConfig(userId: string): Promise<BreweryConfig | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('brewery_configs')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  return data as BreweryConfig | null
}

/**
 * Resolves a user's config to concrete values.
 *
 * Per-client keys (AI + Meta) come ONLY from the brewery's own config row —
 * there is deliberately NO env-var fallback for them, so a brewery that hasn't
 * entered its own keys can never silently spend on / publish from the operator's
 * accounts. Each tenant must bring its own keys (enforced in Settings). Shared
 * infrastructure secrets (Supabase, app ids, queue secret) are read straight
 * from process.env elsewhere — they are not per-client and never live here.
 */
export function resolveConfig(config: BreweryConfig | null): ResolvedConfig {
  return {
    breweryName: config?.brewery_name ?? 'your brewery',
    brandContext: config?.brand_context ?? null,
    googleApiKey: config?.google_api_key ?? '',
    groqApiKey: config?.groq_api_key ?? '',
    mistralApiKey: config?.mistral_api_key ?? '',
    metaIgUserId: config?.meta_ig_user_id ?? '',
    metaAccessToken: config?.meta_access_token ?? '',
    metaFbPageId: config?.meta_fb_page_id ?? null,
    metaAdAccountId: config?.meta_ad_account_id ?? null,
    metaAdsToken: config?.meta_ads_token ?? null,
    logoUrl: config?.logo_url ?? null,
  }
}

/**
 * Resolve Meta credentials for a specific user (or env-var defaults if no user).
 * Used by the cron processor where no session is available — it reads the owner
 * from posts.user_id and looks up that brewery's credentials.
 */
export async function getMetaCredentialsForUser(userId: string | null) {
  const config = userId ? await getUserConfig(userId) : null
  const resolved = resolveConfig(config)
  return {
    igUserId: resolved.metaIgUserId,
    accessToken: resolved.metaAccessToken,
    fbPageId: resolved.metaFbPageId,
  }
}

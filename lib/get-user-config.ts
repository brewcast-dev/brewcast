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
 * Merges a user's DB config with env-var fallbacks.
 * Routes that need API keys should call getUserConfig() then resolveConfig().
 */
export function resolveConfig(config: BreweryConfig | null): ResolvedConfig {
  return {
    breweryName: config?.brewery_name ?? 'your brewery',
    brandContext: config?.brand_context ?? null,
    googleApiKey: config?.google_api_key ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '',
    groqApiKey: config?.groq_api_key ?? process.env.GROQ_API_KEY ?? '',
    mistralApiKey: config?.mistral_api_key ?? process.env.MISTRAL_API_KEY ?? '',
    metaIgUserId: config?.meta_ig_user_id ?? process.env.META_IG_USER_ID ?? '',
    metaAccessToken: config?.meta_access_token ?? process.env.META_ACCESS_TOKEN ?? '',
    metaFbPageId: config?.meta_fb_page_id ?? process.env.META_FB_PAGE_ID ?? null,
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

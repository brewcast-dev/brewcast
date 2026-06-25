'use server'

import sharp from 'sharp'
import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'
import { revalidatePath } from 'next/cache'

const LOGO_BUCKET = 'brand-assets'
const ACCEPTED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
const MAX_LOGO_BYTES = 5 * 1024 * 1024 // 5 MB

export async function saveSettings(formData: FormData): Promise<{ error?: string }> {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const admin = createAdminClient()

  const payload = {
    user_id: user.id,
    brewery_name: (formData.get('brewery_name') as string)?.trim() || null,
    brand_context: (formData.get('brand_context') as string)?.trim() || null,
    google_api_key: (formData.get('google_api_key') as string)?.trim() || null,
    groq_api_key: (formData.get('groq_api_key') as string)?.trim() || null,
    mistral_api_key: (formData.get('mistral_api_key') as string)?.trim() || null,
    meta_app_id: (formData.get('meta_app_id') as string)?.trim() || null,
    meta_app_secret: (formData.get('meta_app_secret') as string)?.trim() || null,
    meta_ig_user_id: (formData.get('meta_ig_user_id') as string)?.trim() || null,
    meta_access_token: (formData.get('meta_access_token') as string)?.trim() || null,
    meta_fb_page_id: (formData.get('meta_fb_page_id') as string)?.trim() || null,
    meta_ad_account_id: (formData.get('meta_ad_account_id') as string)?.trim() || null,
    meta_ads_token: (formData.get('meta_ads_token') as string)?.trim() || null,
    updated_at: new Date().toISOString(),
  }

  // Upsert — creates on first save, updates on subsequent saves
  const { error } = await admin
    .from('brewery_configs')
    .upsert(payload, { onConflict: 'user_id' })

  if (error) return { error: error.message }

  revalidatePath('/settings')
  return {}
}

/**
 * Upload (or replace) the brewery logo. Normalizes any accepted image to a
 * bounded PNG via sharp, stores it in the public brand-assets bucket at a
 * stable per-user path, and records the public URL on brewery_configs. The
 * Design Director renderer stamps this logo on every post.
 */
export async function uploadLogo(formData: FormData): Promise<{ error?: string; logoUrl?: string }> {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const file = formData.get('logo')
  if (!(file instanceof File) || file.size === 0) return { error: 'No file selected' }
  if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
    return { error: 'Use a PNG, JPG, WebP, or SVG. PNG with transparency works best.' }
  }
  if (file.size > MAX_LOGO_BYTES) return { error: 'Logo must be under 5 MB' }

  // Normalize to a bounded PNG so the renderer can rely on a consistent format
  // (transparency preserved; SVG rasterized).
  let png: Buffer
  try {
    const raw = Buffer.from(await file.arrayBuffer())
    png = await sharp(raw, { density: 384 })
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
  } catch (err) {
    return { error: `Couldn't process the image: ${(err as Error).message}` }
  }

  const admin = createAdminClient()
  const path = `logos/${user.id}/logo.png`
  const { error: upErr } = await admin.storage
    .from(LOGO_BUCKET)
    .upload(path, png, { contentType: 'image/png', upsert: true })
  if (upErr) return { error: `Upload failed: ${upErr.message}` }

  // Cache-bust the public URL so a replaced logo isn't served stale.
  const { data: urlData } = admin.storage.from(LOGO_BUCKET).getPublicUrl(path)
  const logoUrl = `${urlData.publicUrl}?v=${Date.now()}`

  const { error: cfgErr } = await admin
    .from('brewery_configs')
    .upsert(
      { user_id: user.id, logo_url: logoUrl, logo_path: path, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )
  if (cfgErr) return { error: cfgErr.message }

  revalidatePath('/settings')
  return { logoUrl }
}

/** Remove the brewery logo (deletes the stored file + clears the config). */
export async function removeLogo(): Promise<{ error?: string }> {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const admin = createAdminClient()
  const { data: cfg } = await admin
    .from('brewery_configs')
    .select('logo_path')
    .eq('user_id', user.id)
    .maybeSingle()

  const path = (cfg as { logo_path: string | null } | null)?.logo_path
  if (path) {
    await admin.storage.from(LOGO_BUCKET).remove([path])
  }

  const { error } = await admin
    .from('brewery_configs')
    .update({ logo_url: null, logo_path: null, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)
  if (error) return { error: error.message }

  revalidatePath('/settings')
  return {}
}

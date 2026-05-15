'use server'

import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'
import { revalidatePath } from 'next/cache'

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

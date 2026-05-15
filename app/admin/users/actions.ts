'use server'

import { createAdminClient } from '@/lib/supabase'
import { createSessionClient } from '@/lib/supabase-server'
import { revalidatePath } from 'next/cache'

async function requireAdmin() {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const admin = createAdminClient()
  const { data } = await admin
    .from('allowed_users')
    .select('is_admin')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!data?.is_admin) throw new Error('Not authorised')
  return admin
}

export async function addAllowedUser(
  formData: FormData,
): Promise<{ error?: string }> {
  const email = (formData.get('email') as string).trim().toLowerCase()
  const breweryName = (formData.get('brewery_name') as string)?.trim() || null
  const isAdmin = formData.get('is_admin') === 'on'

  if (!email) return { error: 'Email is required' }

  const admin = await requireAdmin().catch((e) => { throw e })

  const { error } = await admin.from('allowed_users').insert({
    email,
    brewery_name: breweryName,
    is_admin: isAdmin,
  })

  if (error) return { error: error.message }

  revalidatePath('/admin/users')
  return {}
}

export async function removeAllowedUser(id: string): Promise<{ error?: string }> {
  const admin = await requireAdmin()
  const { error } = await admin.from('allowed_users').delete().eq('id', id)
  if (error) return { error: error.message }
  revalidatePath('/admin/users')
  return {}
}

export async function toggleAdmin(id: string, isAdmin: boolean): Promise<{ error?: string }> {
  const admin = await requireAdmin()
  const { error } = await admin.from('allowed_users').update({ is_admin: isAdmin }).eq('id', id)
  if (error) return { error: error.message }
  revalidatePath('/admin/users')
  return {}
}

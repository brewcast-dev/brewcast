'use server'

import { createSessionClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase'
import { redirect } from 'next/navigation'

export async function signIn(formData: FormData): Promise<{ error: string } | void> {
  const email = (formData.get('email') as string).trim().toLowerCase()
  const password = formData.get('password') as string

  const client = createSessionClient()
  const { data, error } = await client.auth.signInWithPassword({ email, password })

  if (error) return { error: 'Invalid email or password.' }

  // Check allowlist
  const admin = createAdminClient()
  const { data: allowed } = await admin
    .from('allowed_users')
    .select('id, user_id')
    .eq('email', email)
    .maybeSingle()

  if (!allowed) {
    await client.auth.signOut()
    return { error: 'This email is not authorised to access BrewCast.' }
  }

  // First sign-in: link the auth user_id to the allowlist row
  if (!allowed.user_id) {
    await admin.from('allowed_users').update({ user_id: data.user.id }).eq('email', email)
  }

  redirect('/')
}

export async function signOut() {
  const client = createSessionClient()
  await client.auth.signOut()
  redirect('/login')
}

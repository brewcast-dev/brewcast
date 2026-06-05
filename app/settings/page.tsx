import { redirect } from 'next/navigation'
import { createSessionClient } from '@/lib/supabase-server'
import { getUserConfig } from '@/lib/get-user-config'
import SettingsForm from './SettingsForm'
import LogoUpload from './LogoUpload'

export default async function SettingsPage() {
  const client = createSessionClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) redirect('/login')

  const config = await getUserConfig(user.id)

  return (
    <main className="max-w-2xl mx-auto py-10 px-4 space-y-2">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-ash text-sm mt-1">
          Configure API keys and brand identity for this brewery account.
        </p>
      </div>
      <div className="space-y-6">
        <LogoUpload config={config} />
        <SettingsForm config={config} />
      </div>
    </main>
  )
}

'use client'

import { useState } from 'react'
import { saveSettings } from './actions'
import type { BreweryConfig } from '@/lib/get-user-config'

interface Props {
  config: BreweryConfig | null
}

interface FieldDef {
  name: keyof BreweryConfig
  label: string
  placeholder?: string
  textarea?: boolean
  rows?: number
}

const TEXT_FIELDS: FieldDef[] = [
  { name: 'brewery_name', label: 'Brewery Name', placeholder: 'District 6 Brewery' },
  {
    name: 'brand_context',
    label: 'Brand Context (used for caption generation)',
    placeholder: "Describe your brewery's voice, tone, hashtags, and style...",
    textarea: true,
    rows: 5,
  },
]

const AI_KEY_FIELDS: FieldDef[] = [
  { name: 'google_api_key', label: 'Google Gemini API Key', placeholder: 'AIza…' },
  { name: 'groq_api_key', label: 'Groq API Key', placeholder: 'gsk_…' },
  { name: 'mistral_api_key', label: 'Mistral API Key', placeholder: 'mistral-…' },
]

const META_FIELDS: FieldDef[] = [
  { name: 'meta_app_id', label: 'Meta App ID' },
  { name: 'meta_app_secret', label: 'Meta App Secret' },
  { name: 'meta_ig_user_id', label: 'Instagram User ID' },
  { name: 'meta_access_token', label: 'Meta Access Token (long-lived)', textarea: true, rows: 3 },
  { name: 'meta_fb_page_id', label: 'Facebook Page ID (optional)' },
]

function InputField({ field, config }: { field: FieldDef; config: BreweryConfig | null }) {
  const value = config?.[field.name] ?? ''
  const baseClass =
    'w-full bg-onyx border border-white/[0.08] rounded-lg px-3 py-2 text-white text-sm placeholder-smoke focus:outline-none focus:ring-2 focus:ring-cream/30 focus:border-transparent'

  return (
    <div>
      <label className="block text-sm font-medium text-bone mb-1.5">{field.label}</label>
      {field.textarea ? (
        <textarea
          name={field.name}
          defaultValue={value as string}
          rows={field.rows ?? 3}
          placeholder={field.placeholder}
          className={`${baseClass} resize-y`}
        />
      ) : (
        <input
          name={field.name}
          type="text"
          defaultValue={value as string}
          placeholder={field.placeholder}
          className={baseClass}
        />
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-obsidian border border-white/[0.06] rounded-xl p-6 space-y-4">
      <h2 className="text-base font-semibold text-white">{title}</h2>
      {children}
    </section>
  )
}

export default function SettingsForm({ config }: Props) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus('saving')
    setErrorMsg(null)
    const result = await saveSettings(new FormData(e.currentTarget))
    if (result.error) {
      setErrorMsg(result.error)
      setStatus('error')
    } else {
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2500)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Section title="Brewery">
        {TEXT_FIELDS.map((f) => (
          <InputField key={f.name} field={f} config={config} />
        ))}
      </Section>

      <Section title="AI API Keys">
        <p className="text-xs text-ash">
          Leave blank to use the shared environment defaults. Fill in to override with keys
          specific to this brewery account.
        </p>
        {AI_KEY_FIELDS.map((f) => (
          <InputField key={f.name} field={f} config={config} />
        ))}
      </Section>

      <Section title="Meta / Instagram Credentials">
        <p className="text-xs text-ash">
          Required for publishing posts to Instagram and Facebook.
        </p>
        {META_FIELDS.map((f) => (
          <InputField key={f.name} field={f} config={config} />
        ))}
      </Section>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={status === 'saving'}
          className="bg-cream hover:bg-bone disabled:opacity-50 text-ink font-medium rounded-full px-6 py-2.5 text-sm transition-colors"
        >
          {status === 'saving' ? 'Saving…' : 'Save settings'}
        </button>

        {status === 'saved' && (
          <span className="text-emerald-400 text-sm">Saved!</span>
        )}
        {status === 'error' && (
          <span className="text-red-400 text-sm">{errorMsg ?? 'Something went wrong.'}</span>
        )}
      </div>
    </form>
  )
}

/**
 * Quick Pixazo API test — logs status, headers, and body.
 * Usage: npx ts-node --project tsconfig.scripts.json scripts/test-pixazo.ts
 */

import * as fs from 'fs'
import * as path from 'path'

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

async function main() {
  const apiKey = process.env.PIXAZO_API_KEY
  if (!apiKey) {
    console.error('PIXAZO_API_KEY is not set in .env.local')
    process.exit(1)
  }

  const payload = {
    prompt: 'a pint of golden craft beer on a wooden bar, warm lighting, photorealistic',
    num_steps: 4,
    width: 1080,
    height: 1080,
  }

  const url = 'https://gateway.pixazo.ai/flux-1-schnell/v1/getData'
  console.log(`POST ${url}`)
  console.log('Payload:', JSON.stringify(payload, null, 2))
  console.log()

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
    body: JSON.stringify(payload),
  })

  console.log(`Status : ${res.status} ${res.statusText}`)
  console.log('Headers:')
  res.headers.forEach((value, key) => console.log(`  ${key}: ${value}`))
  console.log()

  const raw = await res.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
    console.log('Body (JSON):')
    console.log(JSON.stringify(body, null, 2))
  } catch {
    console.log('Body (raw text):')
    console.log(raw)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

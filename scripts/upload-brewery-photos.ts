/**
 * Bulk-upload local images to Supabase Storage `brewery-photos` bucket.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/upload-brewery-photos.ts <folder>
 *
 * Example:
 *   npx ts-node --project tsconfig.scripts.json scripts/upload-brewery-photos.ts "C:\Users\Lenovo\OneDrive\Desktop\district6-images"
 *
 * Requires env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'

const BUCKET = 'brewery-photos'
const VALID_EXT = /\.(jpe?g|png|webp|gif)$/i

// Load .env.local (matches the pattern used by scripts/scrape-brewery.ts)
function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const key = m[1]
    const val = m[2].replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnvLocal()

async function main() {
  const folder = process.argv[2]
  if (!folder) {
    console.error('Usage: ts-node scripts/upload-brewery-photos.ts <folder>')
    process.exit(1)
  }

  if (!fs.existsSync(folder)) {
    console.error(`Folder not found: ${folder}`)
    process.exit(1)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local')
    process.exit(1)
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  const files = fs.readdirSync(folder).filter((f) => VALID_EXT.test(f))
  console.log(`Found ${files.length} image(s) in ${folder}`)
  if (files.length === 0) return

  let success = 0
  let skipped = 0
  let failed = 0

  for (const file of files) {
    const filePath = path.join(folder, file)
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) continue

    const buffer = fs.readFileSync(filePath)
    const ext = path.extname(file).toLowerCase().replace('.', '')
    const contentType =
      ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'png'  ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif'  ? 'image/gif'
      : 'application/octet-stream'

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(file, buffer, { contentType, upsert: false })

    if (error) {
      if (error.message.toLowerCase().includes('already exists')) {
        console.log(`  ⊘ ${file} (already exists, skipped)`)
        skipped++
      } else {
        console.error(`  ✗ ${file}: ${error.message}`)
        failed++
      }
    } else {
      console.log(`  ✓ ${file} (${(buffer.length / 1024).toFixed(1)} KB)`)
      success++
    }
  }

  console.log(`\nDone — uploaded: ${success}, skipped: ${skipped}, failed: ${failed}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})

import { NextResponse } from 'next/server'
import { createSessionClient } from '@/lib/supabase-server'
import { getFontStatus } from '@/lib/text-to-path'
import fs from 'fs'
import path from 'path'

// Diagnostic endpoint for the design pipeline. Returns:
//   - which fonts loaded and from what path
//   - whether the brewery logo file is reachable
//   - process.cwd() so we can confirm where the lambda is running from
//
// Reach this at GET /api/debug/design. Auth-gated like the design route.
export async function GET() {
  const session = createSessionClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const fonts = getFontStatus()

  const logoCandidates = [
    path.join(process.cwd(), 'public', 'brand', 'logo.png'),
    path.join(process.cwd(), 'public', 'brand', 'logo.jpg'),
    path.join('/var/task', 'public', 'brand', 'logo.png'),
  ]
  const logoStatus = logoCandidates.map((p) => ({
    path: p,
    exists: (() => { try { return fs.existsSync(p) } catch { return false } })(),
    size: (() => {
      try { return fs.statSync(p).size } catch { return null }
    })(),
  }))

  return NextResponse.json({
    cwd: process.cwd(),
    fonts,
    logo: logoStatus,
    env: {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      VERCEL_ENV: process.env.VERCEL_ENV,
    },
  })
}

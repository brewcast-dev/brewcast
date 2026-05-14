import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code) return NextResponse.json({ error: 'No code' }, { status: 400 })

  const appId = process.env.META_IG_APP_ID
  const appSecret = process.env.META_IG_APP_SECRET
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback`

  const res = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: appId!,
      client_secret: appSecret!,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    }),
  })

  const data = await res.json()
  
  // Exchange for long-lived token
  const longRes = await fetch(
    `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${appSecret}&access_token=${data.access_token}`
  )
  const longData = await longRes.json()

  return NextResponse.json({
    short_lived_token: data.access_token,
    long_lived_token: longData.access_token,
    expires_in: longData.expires_in,
    user_id: data.user_id,
  })
}
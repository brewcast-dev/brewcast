import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#0a0a0a',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#ede5d8',
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontStyle: 'italic',
          fontWeight: 600,
          fontSize: 22,
          letterSpacing: -1,
          // Tiny optical shift to centre italic letters visually
          paddingBottom: 2,
          paddingRight: 1,
        }}
      >
        BC
      </div>
    ),
    { ...size },
  )
}

import type { Metadata } from 'next'
import { Inter, Fraunces } from 'next/font/google'
import './globals.css'
import Nav from './_components/Nav'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  display: 'swap',
  axes: ['SOFT', 'opsz'],
})

export const metadata: Metadata = {
  title: 'BrewCast — AI Social Media Manager',
  description: 'AI-powered social media management for your brewery',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
      <body className="font-sans antialiased bg-ink text-cream min-h-screen">
        <Nav />
        {children}
      </body>
    </html>
  )
}

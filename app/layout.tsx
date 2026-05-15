import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Nav from './_components/Nav'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

export const metadata: Metadata = {
  title: 'BrewCast — AI Social Media Manager',
  description: 'AI-powered social media management for your brewery',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased bg-zinc-950 text-zinc-50 min-h-screen">
        <Nav />
        {children}
      </body>
    </html>
  )
}

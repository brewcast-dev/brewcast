import Link from 'next/link'

export default function OnboardingPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="w-full max-w-md space-y-8">
        {/* Logo */}
        <div className="text-center space-y-3">
          <h1 className="text-5xl font-bold tracking-tight text-amber-400">BrewCast</h1>
          <p className="text-zinc-400 text-lg">AI-powered social media manager for your brewery</p>
        </div>

        {/* Setup card */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8 space-y-6">
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-zinc-100">Get started</h2>
            <p className="text-zinc-500 text-sm leading-relaxed">
              BrewCast helps you create Instagram &amp; Facebook content, generate reels, write captions,
              and publish &mdash; all from a single chat interface.
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-start gap-3 text-sm">
              <span className="text-amber-400 mt-0.5 flex-shrink-0">①</span>
              <div>
                <p className="text-zinc-300 font-medium">Run the scrape script</p>
                <p className="text-zinc-500 text-xs mt-0.5">
                  Automatically pull your brewery&apos;s brand from your website:
                </p>
                <code className="block mt-1 text-xs bg-zinc-800 rounded px-2 py-1 text-amber-300 font-mono">
                  npx ts-node scripts/scrape-brewery.ts https://yourbrewery.com
                </code>
              </div>
            </div>
            <div className="flex items-start gap-3 text-sm">
              <span className="text-amber-400 mt-0.5 flex-shrink-0">②</span>
              <div>
                <p className="text-zinc-300 font-medium">Open the chat</p>
                <p className="text-zinc-500 text-xs mt-0.5">
                  Talk to BrewCast like you&apos;d brief a social media manager.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 text-sm">
              <span className="text-amber-400 mt-0.5 flex-shrink-0">③</span>
              <div>
                <p className="text-zinc-300 font-medium">Review & publish</p>
                <p className="text-zinc-500 text-xs mt-0.5">
                  Approve drafts, then publish directly to Instagram & Facebook.
                </p>
              </div>
            </div>
          </div>

          <Link
            href="/chat"
            className="block w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold text-center py-3.5 transition-colors"
          >
            Open BrewCast Chat →
          </Link>
        </div>

        <p className="text-center text-xs text-zinc-600">
          BrewCast PoC · Powered by Gemini + Groq · Publishes via Meta Graph API
        </p>
      </div>
    </main>
  )
}

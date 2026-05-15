import Link from 'next/link'

export default function LandingPage() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* Ambient gradient orbs — set the mood without imagery */}
      <div className="pointer-events-none absolute inset-0 -z-0">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-ember/[0.06] blur-[120px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-cream/[0.04] blur-[120px]" />
      </div>

      <section className="relative max-w-6xl mx-auto px-6 pt-32 pb-24">
        <div className="text-center space-y-8">
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs text-ash hairline">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald" />
            AI-powered social media for breweries
          </span>

          <h1 className="font-display text-6xl md:text-7xl lg:text-8xl text-cream tracking-tight leading-[0.95] text-balance">
            Pour your story.<br />
            <span className="italic text-bone">We&apos;ll post it.</span>
          </h1>

          <p className="text-ash text-lg md:text-xl max-w-xl mx-auto leading-relaxed">
            BrewCast drafts Instagram &amp; Facebook posts, edits photos, schedules
            publishing — all from a single brief.
          </p>

          <div className="flex items-center justify-center gap-3 pt-2">
            <Link
              href="/chat"
              className="px-6 py-3 rounded-full bg-cream text-ink font-medium hover:bg-bone transition-colors"
            >
              Open the chat
            </Link>
            <Link
              href="/upload"
              className="px-6 py-3 rounded-full hairline text-cream hover:bg-white/[0.04] transition-colors"
            >
              Bulk upload photos
            </Link>
          </div>
        </div>
      </section>

      <section className="relative max-w-5xl mx-auto px-6 pb-32">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              num: '01',
              title: 'Brief in plain English',
              body: 'Tell BrewCast what to post. It writes captions, picks hashtags, suggests filters.',
            },
            {
              num: '02',
              title: 'Review &amp; refine',
              body: 'Every draft lands in your queue. Edit, approve, schedule — your call.',
            },
            {
              num: '03',
              title: 'Publish on autopilot',
              body: 'Scheduled posts ship to Instagram and Facebook via the Meta Graph API.',
            },
          ].map((step) => (
            <div
              key={step.num}
              className="rounded-2xl bg-obsidian hairline p-6 hover:bg-onyx transition-colors"
            >
              <div className="font-display text-2xl text-ember/80 mb-3">{step.num}</div>
              <h3 className="font-display text-xl text-cream mb-2" dangerouslySetInnerHTML={{ __html: step.title }} />
              <p className="text-ash text-sm leading-relaxed">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="relative border-t border-white/[0.04] py-8">
        <p className="text-center text-xs text-smoke">
          BrewCast · Powered by Gemini, Groq, Mistral · Publishes via Meta Graph API
        </p>
      </footer>
    </main>
  )
}

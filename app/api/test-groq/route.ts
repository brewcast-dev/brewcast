import { generateText } from 'ai'
import { groq } from '@ai-sdk/groq'

export async function GET() {
  const key = process.env.GROQ_API_KEY
  if (!key) {
    return Response.json({ ok: false, error: 'GROQ_API_KEY is not set' }, { status: 500 })
  }

  try {
    const { text } = await generateText({
      model: groq('llama-3.3-70b-versatile'),
      prompt: 'Reply with exactly: "Groq is working"',
    })
    return Response.json({ ok: true, text, keyPrefix: key.slice(0, 8) + '...' })
  } catch (err) {
    const e = err as Error & { statusCode?: number; status?: number; cause?: unknown }
    console.error('[test-groq] error:', e)
    return Response.json(
      {
        ok: false,
        message: e.message,
        statusCode: e.statusCode ?? e.status,
        cause: e.cause != null ? String(e.cause) : undefined,
        stack: e.stack?.split('\n').slice(0, 6),
      },
      { status: 500 },
    )
  }
}

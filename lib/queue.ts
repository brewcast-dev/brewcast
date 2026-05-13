import { PgBoss } from 'pg-boss'

// SUPABASE_DB_URL format: postgresql://postgres:[password]@[project].supabase.co:5432/postgres
// Find it in: Supabase dashboard → Settings → Database → Connection string (URI)

let boss: InstanceType<typeof PgBoss> | null = null

export async function getBoss(): Promise<InstanceType<typeof PgBoss>> {
  if (boss) return boss

  const dbUrl = process.env.SUPABASE_DB_URL
  if (!dbUrl) throw new Error('SUPABASE_DB_URL is not set — see .env.local.example')

  boss = new PgBoss(dbUrl)
  await boss.start()
  return boss
}

export const PUBLISH_QUEUE = 'publish-post'

export interface PublishJobData {
  post_id: string
}

/**
 * Enqueues a publish job to run at or after scheduledAt.
 * singletonKey = postId prevents duplicate jobs if queuePost is called twice
 * for the same post.
 */
export async function enqueuePublish(postId: string, scheduledAt: string): Promise<void> {
  const b = await getBoss()
  await b.send(
    PUBLISH_QUEUE,
    { post_id: postId } satisfies PublishJobData,
    { startAfter: scheduledAt, singletonKey: postId },
  )
}

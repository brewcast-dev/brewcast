// Hand-written types matching 001_init.sql
// Replace with `supabase gen types typescript` once you've run the migration.

export type PostStatus = 'draft' | 'approved' | 'queued' | 'published' | 'failed'
export type Platform = 'instagram' | 'facebook' | 'both'
export type ContentType = 'post' | 'reel' | 'story'

export interface InspirationCaption {
  caption: string
  likes: number
  comments: number
  mediaType: string
  timestamp: string
}

export interface Brewery {
  id: string
  name: string | null
  website_url: string | null
  tagline: string | null
  about: string | null
  beer_styles: string[] | null
  brand_colors: Record<string, string> | null
  tone_of_voice: string | null
  logo_url: string | null
  ig_handle: string | null
  content_style: string | null
  inspiration_captions: InspirationCaption[] | null
  created_at: string
}

export interface Post {
  id: string
  status: PostStatus
  platform: Platform
  content_type: ContentType
  caption: string | null
  media_urls: string[] | null
  audio_url: string | null
  video_url: string | null
  thumbnail_url: string | null
  scheduled_at: string | null
  published_at: string | null
  meta_post_id: string | null
  ad_targeting: AdTargeting | null
  archived_at: string | null
  created_at: string
}

export interface Analytics {
  id: string
  post_id: string | null
  captured_at: string
  reach: number | null
  impressions: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
  plays: number | null
}

export interface AdTargeting {
  age_range: { min: number; max: number }
  interests: string[]
  location_radius_km: number
  daily_budget_usd: number
  objective: string
}

// Supabase Database type shape used by the typed client
export interface Database {
  public: {
    Tables: {
      brewery: {
        Row: Brewery
        Insert: Omit<Brewery, 'id' | 'created_at'>
        Update: Partial<Omit<Brewery, 'id' | 'created_at'>>
      }
      posts: {
        Row: Post
        Insert: Omit<Post, 'id' | 'created_at'>
        Update: Partial<Omit<Post, 'id' | 'created_at'>>
      }
      analytics: {
        Row: Analytics
        Insert: Omit<Analytics, 'id'>
        Update: Partial<Omit<Analytics, 'id'>>
      }
    }
  }
}

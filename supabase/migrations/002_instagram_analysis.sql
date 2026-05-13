-- Add Instagram analysis fields populated by scripts/analyse-instagram.ts
alter table brewery
  add column if not exists content_style       text,
  add column if not exists inspiration_captions jsonb;

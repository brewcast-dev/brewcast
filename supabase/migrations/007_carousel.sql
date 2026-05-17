-- Add carousel support to the drafts table
alter table drafts
  add column if not exists carousel          boolean  not null default false,
  add column if not exists image_urls        text[]   not null default '{}',
  add column if not exists edited_image_urls text[]   not null default '{}';

-- Extend posts.content_type to include 'carousel'
alter table posts drop constraint if exists posts_content_type_check;
alter table posts
  add constraint posts_content_type_check
  check (content_type in ('post', 'reel', 'story', 'carousel'));

# Brewery brand assets

Drop your logo here as `logo.png` (PNG with transparent background recommended).

The image-design pipeline (`lib/image-design.ts`) reads
`public/brand/logo.png` at composite time and places it in the top-right
corner of each designed post. If the file doesn't exist, the watermark
falls back to just the `@handle` text.

When you onboard a second brewery, this static path becomes a per-user
upload via `/settings` — but for the single-brewery setup right now,
a file checked into the repo is the simplest path.

Best size: anything ≥ 400px wide. The pipeline resizes to ~12% of the
output image width at composite time.

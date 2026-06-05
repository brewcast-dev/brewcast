# Brewery brand assets

## Fonts (`fonts/`)
Bundled TTFs the renderer loads via `lib/text-to-path.ts`:
- `Anton-Regular.ttf` — bold condensed display caps
- `DMSerifDisplay-Italic.ttf` — editorial serif
- `Inter-Variable.ttf` — body / labels
- `Allura-Regular.ttf` — script accent word

## Logos
Logos are **per-brewery** now — there is no shared `logo.png` in the repo.
Each client uploads their own logo at **`/settings`**, which stores it in the
`brand-assets` Supabase bucket and records it on `brewery_configs.logo_url`.
The Design Director renderer loads that logo and stamps it top-centre on every
post. Accounts without an uploaded logo simply get no logo stamped.

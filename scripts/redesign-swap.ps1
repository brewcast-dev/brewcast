# One-off script to swap legacy zinc/amber Tailwind classes to the new
# Obsidian design tokens. Operates on a curated file list.

$replacements = [ordered]@{
  # Backgrounds (most specific first)
  'bg-zinc-950'             = 'bg-ink'
  'bg-zinc-900/80'          = 'bg-obsidian/80'
  'bg-zinc-900/60'          = 'bg-obsidian/60'
  'bg-zinc-900/50'          = 'bg-obsidian/50'
  'bg-zinc-900/40'          = 'bg-obsidian/40'
  'bg-zinc-900'             = 'bg-obsidian'
  'bg-zinc-800/80'          = 'bg-onyx/80'
  'bg-zinc-800/60'          = 'bg-onyx/60'
  'bg-zinc-800/50'          = 'bg-onyx/50'
  'bg-zinc-800/40'          = 'bg-onyx/40'
  'bg-zinc-800'             = 'bg-onyx'
  'bg-zinc-700'             = 'bg-slate'

  # Borders
  'border-zinc-900'         = 'border-white/[0.04]'
  'border-zinc-800'         = 'border-white/[0.06]'
  'border-zinc-700'         = 'border-white/[0.08]'
  'border-b-zinc-800'       = 'border-b-white/[0.06]'
  'border-t-zinc-800'       = 'border-t-white/[0.06]'

  # Text scales (zinc 50 → cream, zinc 600 → smoke)
  'text-zinc-50'            = 'text-cream'
  'text-zinc-100'           = 'text-cream'
  'text-zinc-200'           = 'text-cream'
  'text-zinc-300'           = 'text-bone'
  'text-zinc-400'           = 'text-ash'
  'text-zinc-500'           = 'text-ash'
  'text-zinc-600'           = 'text-smoke'
  'text-zinc-700'           = 'text-smoke'
  'text-zinc-950'           = 'text-ink'

  # Placeholders
  'placeholder-zinc-500'    = 'placeholder-smoke'
  'placeholder-zinc-600'    = 'placeholder-smoke'

  # Amber → cream / ember accents
  'bg-amber-500'            = 'bg-cream'
  'bg-amber-400'            = 'bg-bone'
  'bg-amber-700'            = 'bg-ember/40'
  'bg-amber-900/40'         = 'bg-ember/10'
  'bg-amber-950/40'         = 'bg-ember/10'
  'bg-amber-950'            = 'bg-ember/15'
  'bg-amber-900'            = 'bg-ember/20'
  'bg-amber-500/10'         = 'bg-ember/10'
  'bg-amber-500/20'         = 'bg-ember/20'
  'text-amber-300'          = 'text-ember'
  'text-amber-400'          = 'text-cream'
  'text-amber-500'          = 'text-ember'
  'text-amber-50'           = 'text-cream'
  'border-amber-500'        = 'border-cream/30'
  'border-amber-700'        = 'border-ember/30'
  'border-amber-800'        = 'border-ember/30'
  'focus:ring-amber-500'    = 'focus:ring-cream/30'
  'focus:border-amber-500'  = 'focus:border-cream/30'
  'hover:bg-amber-400'      = 'hover:bg-bone'
  'hover:bg-amber-600'      = 'hover:bg-cream'
  'hover:border-amber-700'  = 'hover:border-ember/40'
  'hover:text-amber-400'    = 'hover:text-cream'

  # Hover surfaces
  'hover:bg-zinc-800'       = 'hover:bg-onyx'
  'hover:bg-zinc-900'       = 'hover:bg-obsidian'
  'hover:text-zinc-200'     = 'hover:text-cream'
  'hover:text-zinc-300'     = 'hover:text-cream'
  'hover:border-zinc-700'   = 'hover:border-white/[0.12]'

  # Misc legacy that snuck in
  'border-zinc-600'         = 'border-white/[0.10]'
  'bg-zinc-600'             = 'bg-onyx'
}

$files = @(
  'app\drafts\[id]\_components\PostReview.tsx',
  'app\drafts\[id]\_components\UploadDraftReview.tsx',
  'app\upload\page.tsx',
  'app\chat\_components\ChatInterface.tsx',
  'app\chat\_components\InputBar.tsx',
  'app\chat\_components\Sidebar.tsx',
  'app\chat\_components\MessageBubble.tsx',
  'app\chat\page.tsx',
  'app\settings\page.tsx',
  'app\settings\SettingsForm.tsx',
  'app\admin\users\page.tsx',
  'app\admin\users\AddUserForm.tsx',
  'app\admin\users\UserRow.tsx',
  'app\admin\users\ProcessQueueButton.tsx',
  'app\analytics\page.tsx'
)

$root = 'C:\Users\Lenovo\brewcast'
$changed = 0
$skipped = 0

foreach ($rel in $files) {
  $path = Join-Path $root $rel
  if (-not (Test-Path $path)) {
    Write-Host "  SKIP (missing): $rel"
    $skipped++
    continue
  }
  $content = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  $orig = $content
  foreach ($r in $replacements.GetEnumerator()) {
    $content = $content -replace [regex]::Escape($r.Key), $r.Value
  }
  if ($content -ne $orig) {
    Set-Content -LiteralPath $path -Value $content -Encoding UTF8 -NoNewline
    Write-Host "  swapped: $rel"
    $changed++
  } else {
    Write-Host "  unchanged: $rel"
  }
}

Write-Host ""
Write-Host "Done. Changed $changed file(s). Skipped $skipped."

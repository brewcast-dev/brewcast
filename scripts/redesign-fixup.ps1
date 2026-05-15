# Cleanup pass: fix artifacts from the first swap script and catch missed
# patterns. Longest keys first to avoid prefix-matching bugs.

$replacements = [ordered]@{
  # ── Fix artifacts from prefix-collision (text-zinc-50 matched text-zinc-500)
  'text-cream0'             = 'text-ash'

  # ── Misses: zinc shades not in original list
  'text-zinc-900'           = 'text-cream'
  'bg-zinc-400'             = 'bg-ash'
  'text-zinc-800'           = 'text-onyx'
  'bg-zinc-500'             = 'bg-ash'

  # ── Border red/green still using legacy zinc-adjacent shades
  'border-red-800'          = 'border-red-900/50'
  'bg-red-950'              = 'bg-red-950/40'
  'border-green-800'        = 'border-emerald/30'
  'bg-green-950'            = 'bg-emerald/10'
  'bg-green-600'            = 'bg-emerald'
  'hover:bg-green-500'      = 'hover:bg-emerald/80'
  'text-green-300'          = 'text-emerald'
  'text-green-400'          = 'text-emerald'
  'bg-blue-900'             = 'bg-sky-500/15'
  'text-blue-300'           = 'text-sky-300'
  'bg-blue-600'             = 'bg-sky-500/20'
  'hover:bg-blue-500'       = 'hover:bg-sky-500/30'

  # ── Misc cleanup
  'shadow-xl'               = 'shadow-2xl shadow-black/40'
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

foreach ($rel in $files) {
  $path = Join-Path $root $rel
  if (-not (Test-Path $path)) {
    Write-Host "  SKIP (missing): $rel"
    continue
  }
  $content = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  $orig = $content
  foreach ($r in $replacements.GetEnumerator()) {
    $content = $content -replace [regex]::Escape($r.Key), $r.Value
  }
  if ($content -ne $orig) {
    Set-Content -LiteralPath $path -Value $content -Encoding UTF8 -NoNewline
    Write-Host "  fixed: $rel"
    $changed++
  }
}

Write-Host ""
Write-Host "Fixed $changed file(s)."

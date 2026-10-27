param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.release'))
$target = (Resolve-Path -LiteralPath $Directory).Path
if (-not $target.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'SIGNING_PATH_INVALID' }
$cursor = $target
while ($true) {
  $item = Get-Item -LiteralPath $cursor
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'SIGNING_PATH_INVALID' }
  if ([string]::Equals($cursor,$releaseRoot,[StringComparison]::OrdinalIgnoreCase)) { break }
  $cursor = Split-Path -Parent $cursor
  if (-not $cursor.StartsWith($releaseRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'SIGNING_PATH_INVALID' }
}
if (-not $env:CQS_SIGNING_PFX_BASE64 -or -not $env:CQS_SIGNING_PASSWORD -or $env:CQS_SIGNING_THUMBPRINT -notmatch '^[a-fA-F0-9]{40}$') { throw 'SIGNING_CREDENTIALS_MISSING' }
$manifestPath = Join-Path $target 'release.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.product -ne 'CodexQuotaScheduler' -or $manifest.file -notmatch '^CodexQuotaScheduler-[0-9]+\.[0-9]+\.[0-9]+-win-x64-setup\.exe$') { throw 'SIGNING_MANIFEST_INVALID' }
$installerPath = Join-Path $target $manifest.file
if ((Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw 'SIGNING_HASH_MISMATCH' }
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$tools = @(Get-ChildItem -LiteralPath $sdkRoot -Directory | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'x64/signtool.exe' } | Where-Object { Test-Path -LiteralPath $_ })
if ($tools.Count -eq 0) { throw 'SIGNING_TOOL_MISSING' }
$temporary = Join-Path $target ('certificate-' + [Guid]::NewGuid().ToString() + '.pfx')
try {
  [IO.File]::WriteAllBytes($temporary,[Convert]::FromBase64String($env:CQS_SIGNING_PFX_BASE64))
  $timestamp = if ($env:CQS_TIMESTAMP_URL) { $env:CQS_TIMESTAMP_URL } else { 'https://timestamp.digicert.com' }
  if ($timestamp -notmatch '^https://[a-zA-Z0-9.-]+(?::[0-9]+)?(?:/[a-zA-Z0-9/_.-]*)?$') { throw 'SIGNING_TIMESTAMP_INVALID' }
  & $tools[0] sign /fd SHA256 /td SHA256 /tr $timestamp /f $temporary /p $env:CQS_SIGNING_PASSWORD $installerPath
  if ($LASTEXITCODE -ne 0) { throw 'SIGNING_FAILED' }
  $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $env:CQS_SIGNING_THUMBPRINT -or $null -eq $signature.TimeStamperCertificate) { throw 'SIGNING_VERIFICATION_FAILED' }
  $manifest.sha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifest.unsigned = $false
  [IO.File]::WriteAllText(($installerPath + '.sha256'),($manifest.sha256 + '  ' + $manifest.file + "`n"),(New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}

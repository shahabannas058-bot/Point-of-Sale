<#
.SYNOPSIS
  Restore, build and test apps/shell-dotnet without ever contacting nuget.org.

.DESCRIPTION
  1. Preflight: SDK 10+, a local NuGet source that really holds .nupkg files, and the repo folders the .NET side
     reads at build/test time (packages/db/migrations/*.sql are embedded by PosShell.Infrastructure,
     testdata/*.json are copied next to the test dll). Every problem is listed at once.
  2. Restore with --source <folder> only, so nothing can time out on the network.
  3. Build and test with --no-restore.

  PosShell.App (WPF) is skipped unless -IncludeApp is passed: it also needs Microsoft.Web.WebView2 in the source.

.EXAMPLE
  .\tools\offline-restore.ps1 -Source D:\nuget-offline
.EXAMPLE
  $env:POS_NUGET_SOURCE = 'D:\nuget-offline'; .\tools\offline-restore.ps1 -SkipTests

.NOTES
  Making the source permanent for this PC (user-level config, nothing is written to the repo):
    dotnet nuget add source D:\nuget-offline --name pos-offline
    dotnet nuget disable source nuget.org          # re-enable later: dotnet nuget enable source nuget.org
  Keep the extracted package cache off OneDrive:
    setx NUGET_PACKAGES D:\nuget                   # open a new terminal afterwards
  The csprojs use floating versions ("*", "9.*"). Against a local folder they resolve to the highest version in it.
  Once restore works, pin the resolved versions (see obj/project.assets.json) so every machine builds the same bits.
#>
[CmdletBinding()]
param(
    [string]$Source = $env:POS_NUGET_SOURCE,
    [string]$PackagesCache = $env:NUGET_PACKAGES,
    [switch]$SkipTests,
    [switch]$IncludeApp
)

$ErrorActionPreference = 'Stop'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'

$shell = Split-Path -Parent $PSScriptRoot
$repo = (Resolve-Path (Join-Path $shell '..\..')).Path
$problems = New-Object System.Collections.Generic.List[string]

# --- preflight -------------------------------------------------------------------------------------------------
$sdk = (& dotnet --version 2>$null)
if (-not $sdk) { $problems.Add('dotnet is not on PATH (expected C:\Program Files\dotnet\dotnet.exe).') }
elseif ([int]($sdk.Split('.')[0]) -lt 10) { $problems.Add("SDK $sdk found, the projects target net10.0 and need SDK 10+.") }

if (-not $Source) { $problems.Add('No package source: pass -Source <folder> or set POS_NUGET_SOURCE.') }
elseif (-not (Test-Path $Source)) { $problems.Add("Package source '$Source' does not exist.") }
elseif (-not (Get-ChildItem $Source -Filter *.nupkg -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    $problems.Add("Package source '$Source' contains no .nupkg files.")
}

$sql = @(Get-ChildItem (Join-Path $repo 'packages\db\migrations') -Filter *.sql -ErrorAction SilentlyContinue)
if ($sql.Count -eq 0) { $problems.Add('packages\db\migrations\*.sql missing: Infrastructure would embed zero migrations.') }
foreach ($f in 'helper-vectors', 'invoice-vectors', 'migration-checksums', 'uuid-vectors') {
    if (-not (Test-Path (Join-Path $repo "testdata\$f.json"))) { $problems.Add("testdata\$f.json missing (generate with: npm run vectors).") }
}

if ($problems.Count -gt 0) {
    Write-Host 'Preflight failed:' -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
if ($PackagesCache) { $env:NUGET_PACKAGES = $PackagesCache }
Write-Host "SDK $sdk | source $Source | $($sql.Count) migrations | testdata ok" -ForegroundColor Green

# --- restore / build / test ------------------------------------------------------------------------------------
$projects = @('PosShell.Core', 'PosShell.Infrastructure', 'PosShell.Core.Tests', 'PosShell.Infrastructure.Tests')
if ($IncludeApp) { $projects += 'PosShell.App' }

function Invoke-Dotnet {
    param([string[]]$Arguments)
    Write-Host "> dotnet $($Arguments -join ' ')" -ForegroundColor Cyan
    & dotnet @Arguments
    if ($LASTEXITCODE -ne 0) { throw "dotnet $($Arguments[0]) failed (exit $LASTEXITCODE)" }
}

Push-Location $shell
try {
    foreach ($p in $projects) { Invoke-Dotnet @('restore', $p, '--source', $Source) }
    foreach ($p in $projects) { Invoke-Dotnet @('build', $p, '--no-restore') }
    if (-not $SkipTests) {
        foreach ($p in $projects | Where-Object { $_ -like '*.Tests' }) { Invoke-Dotnet @('test', $p, '--no-restore') }
    }
}
finally { Pop-Location }
Write-Host 'Offline restore, build and test finished.' -ForegroundColor Green

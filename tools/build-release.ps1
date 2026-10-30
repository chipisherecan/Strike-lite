# Builds everything a GitHub release needs into dist\:
#   StrikeLiteLauncher.exe        launcher with the official Radmin VPN installer embedded
#   strike-lite-game.zip          game files + portable Node.js (what auto-updates download)
#   *.sha256, launcher-version.txt
# Usage: powershell -File tools\build-release.ps1 -Repo owner/name -Tag v1.0.0
param(
  [Parameter(Mandatory)] [string] $Repo,
  [Parameter(Mandatory)] [string] $Tag,
  [string] $ApiBase = 'https://api.github.com',
  [string] $RadminInstaller = ''    # optional local copy, otherwise downloaded and checked against the pinned hash
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
Add-Type -AssemblyName System.IO.Compression.FileSystem

# --- pinned third-party downloads; update these together when moving to a new version
$NodeVersion = '22.17.0'
$RadminFile = 'Radmin_VPN_2.1.4951.1.exe'
$RadminUrl = "https://download.radmin-vpn.com/download/files/$RadminFile"
$RadminSha = (Get-Content (Join-Path $PSScriptRoot '..\launcher\radmin.sha256') -Raw).Trim()

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$dist = Join-Path $root 'dist'
$work = Join-Path $dist 'work'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force $work | Out-Null
$wc = New-Object Net.WebClient

function Write-Sha($file) {
  (Get-FileHash $file -Algorithm SHA256).Hash.ToLower() | Out-File "$file.sha256" -Encoding ascii -NoNewline
}

# --- game package
$game = Join-Path $work 'game'
New-Item -ItemType Directory -Force $game | Out-Null
foreach ($item in 'server.js', 'package.json', 'package-lock.json', 'public', 'shared') { Copy-Item (Join-Path $root $item) $game -Recurse }
Remove-Item (Join-Path $game 'shared\mapdata\edits.backup.js') -ErrorAction SilentlyContinue
Push-Location $game
& npm ci --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
Pop-Location
# only three's build folder is served to the browser
Get-ChildItem (Join-Path $game 'node_modules\three') | Where-Object { $_.Name -notin 'build', 'package.json', 'LICENSE' } | Remove-Item -Recurse -Force

$nodeZip = Join-Path $work 'node.zip'
$nodeName = "node-v$NodeVersion-win-x64"
$wc.DownloadFile("https://nodejs.org/dist/v$NodeVersion/$nodeName.zip", $nodeZip)
$sums = $wc.DownloadString("https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt")
$wanted = ($sums -split "`n" | Where-Object { $_ -match "\s$nodeName\.zip$" }) -replace '\s.*$', ''
if ((Get-FileHash $nodeZip -Algorithm SHA256).Hash.ToLower() -ne $wanted) { throw 'Node.js download failed its checksum' }
[IO.Compression.ZipFile]::ExtractToDirectory($nodeZip, $work)
New-Item -ItemType Directory -Force (Join-Path $game 'node') | Out-Null
Copy-Item (Join-Path $work "$nodeName\node.exe"), (Join-Path $work "$nodeName\LICENSE") (Join-Path $game 'node')

$zip = Join-Path $dist 'strike-lite-game.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($game, $zip)
Write-Sha $zip

# --- launcher
if (-not $RadminInstaller) { $RadminInstaller = Join-Path $work $RadminFile; $wc.DownloadFile($RadminUrl, $RadminInstaller) }
if ((Get-FileHash $RadminInstaller -Algorithm SHA256).Hash.ToLower() -ne $RadminSha.ToLower()) { throw 'Radmin installer does not match the pinned checksum' }

$launcherVersion = [int](Get-Content (Join-Path $root 'launcher\launcher-version.txt') -Raw).Trim()
$buildInfo = Join-Path $work 'BuildInfo.cs'
@"
static class BuildInfo {
    public const string Repo = "$Repo";
    public const string ApiBase = "$ApiBase";
    public const int LauncherVersion = $launcherVersion;
    public const string RadminFile = "$RadminFile";
}
"@ | Out-File $buildInfo -Encoding utf8

$exe = Join-Path $dist 'StrikeLiteLauncher.exe'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe "/out:$exe" /optimize+ "/resource:$RadminInstaller,radmin.exe" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
  (Join-Path $root 'launcher\Launcher.cs') $buildInfo
if ($LASTEXITCODE -ne 0) { throw 'Launcher failed to compile' }
Write-Sha $exe
$launcherVersion | Out-File (Join-Path $dist 'launcher-version.txt') -Encoding ascii -NoNewline

Remove-Item $work -Recurse -Force
Get-ChildItem $dist | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }

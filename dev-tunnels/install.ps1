# Downloads the newest t3code-disconnected Windows release, installs it silently
# for the current user and starts the desktop app. See dev-tunnels/README.md.
# Usage: .\install.ps1 [-Tag disconnected-0.1.6-1] [-Force] [-NoLaunch]
param(
  # Release tag to install. Empty picks the newest disconnected-* release.
  [string]$Tag = "",
  [string]$Repo = "mishpajz/t3code-disconnected",
  # Reinstall even when that version is already installed.
  [switch]$Force,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1: GitHub needs TLS 1.2, and the progress bar slows downloads badly.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = "SilentlyContinue"

$productName = "T3 Code Disconnected"
$appExe = "$env:LOCALAPPDATA\Programs\t3code-disconnected\$productName.exe"

# The releases are prereleases, which /releases/latest skips.
$releases = Invoke-RestMethod -Headers @{ "User-Agent" = "t3code-disconnected-install" } `
  -Uri "https://api.github.com/repos/$Repo/releases?per_page=30"
$release = $releases |
  Where-Object { -not $_.draft -and $_.tag_name -like "disconnected-*" -and (-not $Tag -or $_.tag_name -eq $Tag) } |
  Sort-Object { [datetime]$_.published_at } -Descending |
  Select-Object -First 1
if (-not $release) { throw "No release$(if ($Tag) { " $Tag" }) found in $Repo." }
$asset = $release.assets | Where-Object { $_.name -like "*-x64.exe" } | Select-Object -First 1
if (-not $asset) { throw "Release $($release.tag_name) has no x64 installer." }
$version = $release.tag_name -replace "^disconnected-", ""

$installed = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like "$productName*" } | Select-Object -First 1
if ($installed -and $installed.DisplayVersion -eq $version -and -not $Force -and (Test-Path $appExe)) {
  Write-Host "$productName $version is already installed."
} else {
  $dir = Join-Path $env:TEMP "t3code-disconnected-install"
  New-Item -ItemType Directory -Force $dir | Out-Null
  $installer = Join-Path $dir $asset.name
  Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB)) MB)..."
  Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $installer
  if ((Get-Item $installer).Length -ne $asset.size) { throw "Download of $($asset.name) is incomplete." }
  Unblock-File $installer

  # The silent installer closes a running copy of the app, and its bundled server, first.
  Write-Host "Installing $productName $version..."
  $process = Start-Process -FilePath $installer -ArgumentList "/S" -Wait -PassThru
  Remove-Item $installer -ErrorAction SilentlyContinue
  if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode)." }
  Write-Host "Installed $productName $version."
}

if (-not $NoLaunch) {
  if (-not (Test-Path $appExe)) { throw "$appExe not found after install." }
  Start-Process -FilePath $appExe
}

# Starts a worker's T3 server and its Dev Tunnel host in the background, with
# hidden windows and output written to log files. See dev-tunnels/README.md.
# Usage: .\start-worker.ps1 -Port 4771 -Tunnel worker-1 [-Repos C:\src]
param(
  [Parameter(Mandatory)][int]$Port,
  [Parameter(Mandatory)][string]$Tunnel,
  # Default working directory for agent sessions.
  [string]$Repos = "C:\src"
)

$logs = "$env:USERPROFILE\.t3\worker-logs"
New-Item -ItemType Directory -Force $logs | Out-Null

# The t3 command the desktop app installs (Settings -> General -> t3 command).
# `cmd /c` strips the first and last quote of its command line, so the whole
# line is wrapped in one more pair of quotes.
$t3 = "$env:USERPROFILE\.t3\bin\t3.cmd"
if (-not (Test-Path $t3)) { throw "$t3 not found. Install the t3 command from the desktop app first." }
if (-not (Test-Path $Repos)) { throw "Repos folder $Repos not found. Pass -Repos <folder>." }
Start-Process -WindowStyle Hidden -FilePath "cmd.exe" `
  -ArgumentList "/c", "`"`"$t3`" serve --host 127.0.0.1 --port $Port `"$Repos`"`"" `
  -RedirectStandardOutput "$logs\t3-$Port.log" -RedirectStandardError "$logs\t3-$Port.err.log"

Start-Process -WindowStyle Hidden -FilePath "devtunnel" -ArgumentList "host", $Tunnel `
  -RedirectStandardOutput "$logs\devtunnel-$Tunnel.log" -RedirectStandardError "$logs\devtunnel-$Tunnel.err.log"

Write-Host "Started t3 on port $Port and tunnel $Tunnel. Logs in $logs"

# Connects the control machine to each worker's Dev Tunnel in the background,
# forwarding every worker's port to 127.0.0.1. See dev-tunnels/README.md.
# Usage: .\start-tunnels.ps1 worker-1, worker-2, worker-3
param(
  [Parameter(Mandatory)][string[]]$Tunnels
)

$logs = "$env:USERPROFILE\.t3\tunnel-logs"
New-Item -ItemType Directory -Force $logs | Out-Null
foreach ($t in $Tunnels) {
  Start-Process -WindowStyle Hidden -FilePath "devtunnel" -ArgumentList "connect", $t `
    -RedirectStandardOutput "$logs\$t.log" -RedirectStandardError "$logs\$t.err.log"
}
Write-Host "Connecting $($Tunnels -join ', '). Logs in $logs"

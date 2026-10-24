# Stops what start-worker.ps1 started: the T3 server listening on the port (not
# the desktop app) and the devtunnel process hosting this tunnel.
# Usage: .\stop-worker.ps1 -Port 4771 -Tunnel worker-1
param(
  [Parameter(Mandatory)][int]$Port,
  [Parameter(Mandatory)][string]$Tunnel
)

Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

Get-CimInstance Win32_Process -Filter "Name = 'devtunnel.exe'" |
  Where-Object { $_.CommandLine -match "\bhost\s+$([regex]::Escape($Tunnel))\b" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "Stopped t3 on port $Port and tunnel $Tunnel."

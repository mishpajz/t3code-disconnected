# Stops the devtunnel connections start-tunnels.ps1 started. With no tunnel
# names it stops every `devtunnel connect` on this machine.
# Usage: .\stop-tunnels.ps1 [worker-1, worker-2]
param(
  [string[]]$Tunnels = @()
)

Get-CimInstance Win32_Process -Filter "Name = 'devtunnel.exe'" |
  Where-Object {
    $line = $_.CommandLine
    $line -match "\bconnect\b" -and
      ($Tunnels.Count -eq 0 -or ($Tunnels | Where-Object { $line -match "\bconnect\s+$([regex]::Escape($_))\b" }))
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "Stopped tunnel connections."

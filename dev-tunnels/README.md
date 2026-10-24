# Dev Tunnel scripts

PowerShell scripts that run the [remote access setup](../DISCONNECTED.md#remote-access-over-dev-tunnels)
in the background on Windows: hidden windows, output in log files.

Before the first run, on every machine:

- `devtunnel user login`, interactively. The hidden processes reuse the cached login but
  cannot show a prompt.
- On workers: the `t3` command (**Settings → General → t3 command** in the desktop app), and
  the tunnel itself (`devtunnel create worker-1`, `devtunnel port create worker-1 -p 4771`).

## Workers

```powershell
.\start-worker.ps1 -Port 4771 -Tunnel worker-1 [-Repos C:\src]
.\stop-worker.ps1  -Port 4771 -Tunnel worker-1
```

`start-worker.ps1` runs `t3 serve --host 127.0.0.1 --port <Port> <Repos>` and
`devtunnel host <Tunnel>`. `-Repos` is the default working directory for agent sessions.
`stop-worker.ps1` stops the server listening on the port, not the desktop app, and the
`devtunnel` hosting that tunnel. Logs are in `%USERPROFILE%\.t3\worker-logs`
(`t3-4771.log`, `devtunnel-worker-1.log`):

```powershell
Get-Content "$env:USERPROFILE\.t3\worker-logs\t3-4771.log" -Wait -Tail 30
t3 pair --label control --ttl 30m
```

## Control machine

```powershell
.\start-tunnels.ps1 worker-1, worker-2, worker-3
.\stop-tunnels.ps1  [worker-1, worker-2]       # no names stops every connection
```

Each worker's port is forwarded to `127.0.0.1` on this machine. Logs are in
`%USERPROFILE%\.t3\tunnel-logs`.

## Start at logon

Press Win+R, open `shell:startup` and add a shortcut with this target:

```
powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\path\to\start-worker.ps1" -Port 4771 -Tunnel worker-1
powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\path\to\start-tunnels.ps1" -Tunnels worker-1,worker-2,worker-3
```

Disconnecting from Remote Desktop keeps the processes running; signing out or rebooting
stops them. If a tunnel stops working after a few days, check its `.err.log`: the Dev
Tunnels login has probably expired.

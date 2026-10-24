# Egress check

Verifies that the server and web UI make no outbound connections. It runs them
in a Docker container on a network with no route to the internet and records
every attempt, so it does not depend on anything honouring `HTTP_PROXY`, and
nothing can leak while it runs.

```bash
egress-check/check.sh          # build, then run with 6 minutes of idle time
egress-check/check.sh 60       # shorter idle time
```

Needs Docker. The image build has internet access (it installs dependencies
and builds the server and web UI); only the run is offline.

## What it does

1. **DNS logger.** The container's resolver points at a small DNS server
   (`dns-logger.mjs`) that records every lookup and answers NXDOMAIN, so nothing
   resolves.
2. **Packet capture.** `tcpdump` records every outbound TCP connection attempt
   and UDP packet, including ones to hard-coded IPs that skip DNS. A default route
   through the sandbox bridge makes those attempts send a packet that the capture
   sees and Docker's network isolation drops.
3. **Sanity check.** It confirms `https://1.1.1.1` is unreachable before
   starting, and aborts otherwise.
4. **Server and UI.** It runs `t3 serve`, pairs headless Chromium through the
   pairing URL, opens the main screens (`drive.mjs`), then stays idle so
   background timers fire.
5. **Report.** `analyze.mjs` lists every hostname and IP contacted, writes
   `out/report.json`, and fails on anything not in `allowlist.txt`.

Results land in `egress-check/out/`: the report, `dns.jsonl`, `packets.txt`,
`server.log`, `drive.log`, and a screenshot of the UI (`ui.png`).

## Limits

- **No agents are installed.** Agent CLIs talk to their own vendors, which this
  fork leaves alone, so this covers T3 Code's own traffic only.
- **Only first attempts show up.** Nothing resolves, so calls that would only
  follow a successful earlier call never happen. For "no calls at all" that is
  enough: any attempt fails the check.
- **The desktop app's Electron process isn't covered yet.** Auto-update, Clerk
  and Tailscale discovery live there.
- **Coverage depends on what gets exercised.** Features that only make calls
  when used (adding an ACP registry agent, browsing themes, opening a pull
  request) need steps in `drive.mjs` to be checked.

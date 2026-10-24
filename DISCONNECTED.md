# t3code-disconnected

A fork of [T3 Code](https://github.com/pingdotgg/t3code) for networks where software may
not send data to outside services. The server, web UI, desktop app and orchestration stay
as they are. Only the code that talks to servers other than the ones you point it at is
removed or turned off.

## Goals

- **No calls home.** No analytics, update checks, version checks or downloads from T3,
  npm, GitHub or other third-party hosts unless you start them yourself.
- **No VPN-like software.** Nothing in the build installs, downloads or runs tunnel or VPN
  clients (cloudflared, Tailscale). Remote access uses whatever transport you already
  have, such as [Microsoft Dev Tunnels](#remote-access-over-dev-tunnels).
- **Easy to keep up with upstream.** Changes are small and gated in place so rebases stay
  cheap. Whole subsystems are deleted only when they would otherwise ship tunnel clients.

## Non-goals

- **Agents and their vendors.** The coding agents you run (Copilot CLI, Claude, Codex and so
  on) talk to their own services. This fork does not change that; use the ones you are
  allowed to use.
- **Git hosting and source-control integrations.** These talk to the hosts you configure
  (for example Azure DevOps through `az`). They stay.
- **The built-in browser.** It can still download Chrome on first use and browse wherever
  you or an agent navigate.
- **Mobile app.** Out of scope; it depends on T3 Connect for push notifications.

## Changes

Status: **planned**. Items are ticked as they land.

### Removed from the build

- [ ] **T3 Connect.** The cloud relay, account linking, managed endpoints, agent-activity
      publishing and held-webhook wake-ups (`apps/server/src/cloud`, `apps/server/src/relay`,
      `packages/client-runtime/src/relay`).
- [ ] **cloudflared.** Downloaded and run only for T3 Connect (`packages/shared/src/relayClient.ts`).
- [ ] **Clerk sign-in.** Only used by T3 Connect (`apps/web/src/components/clerk`,
      `apps/desktop/src/app/DesktopClerk.ts`).
- [ ] **Tailscale integration.** It never installs Tailscale, but it runs the `tailscale`
      command when network access or Tailscale Serve is on (`packages/tailscale`,
      `apps/desktop/src/backend/tailscaleEndpointProvider.ts`,
      `apps/server/src/environment/DirectEndpoints.ts`).

### Turned off by default

- [ ] **Product analytics** (PostHog at `ingest.t3.codes`): forced off
      (`apps/server/src/telemetry/AnalyticsService.ts`).
- [ ] **Desktop auto-update checks** against GitHub releases: off
      (`apps/desktop/src/updates/DesktopUpdates.ts`).
- [ ] **Model list download** from GitHub and **provider version checks**:
      `enableProviderUpdateChecks` defaults to `false`
      (`apps/server/src/provider/ModelManifest.ts`,
      `packages/provider-core/src/server/maintenanceResolver.ts`).
- [ ] **OpenTelemetry export**: stays unconfigured; no endpoints are baked into builds.

### Patched to stay local

- [ ] **npm version check** from the web UI every five minutes (`apps/web/src/state/npmRelease.ts`).
- [ ] **CLI self-update and runtime downloads** (`t3 update`, npm launcher, SSH bootstrap).
- [ ] **LiteLLM pricing** fetched from GitHub: use bundled rates
      (`apps/server/src/usage/UsageService.ts`).
- [ ] **ACP registry**: local ACP commands only, no registry index, package downloads or CDN
      icons (`packages/provider-acp-registry`, `apps/web/src/components/settings/AcpRegistryIcon.tsx`).
- [ ] **Favicons and external images** in chat and links: no Google favicon service
      (`packages/shared/src/favicon.ts`).
- [ ] **Theme marketplace** (open-vsx.org): hidden (`apps/web/src/openVsxThemes.ts`).

### Other changes

- [ ] **Copilot launched through a wrapper.** Copilot-specific handling (nested subagents)
      also applies when Copilot is started through a wrapper executable, not only one named
      `copilot` (`packages/provider-acp-registry/src/server/adapter.ts`).
- [ ] **Outbound check script.** Lists outbound URLs and tunnel or VPN tool names in the
      source, to rerun after each upstream rebase.

## Remote access over Dev Tunnels

T3 Code connects to a remote environment over a single HTTP port, with a WebSocket at `/ws`,
and protects it with its own pairing. That works through an authenticated
[Dev Tunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/) without code changes.

On each worker machine:

```powershell
devtunnel user login
t3 serve --port 4771                     # one port per worker: 4771, 4772, ...
devtunnel create worker-1
devtunnel port create worker-1 -p 4771
devtunnel host worker-1
t3 pair                                  # prints the pairing code
```

On the machine running the UI:

```powershell
devtunnel user login                     # same account
devtunnel connect worker-1               # forwards to 127.0.0.1:4771
```

Then use **Settings → Connections → Add environment** with `http://127.0.0.1:4771` and the
pairing code. Repeat for each worker, and turn on **Load balancing** to spread new threads
across them.

## Staying in sync with upstream

```bash
git fetch upstream
git rebase upstream/main
```

`upstream` is fetch-only in this clone (`git remote set-url --push upstream no-push`).

The list of outbound calls above comes from an audit of upstream at commit
[`bb7783e`](https://github.com/pingdotgg/t3code/commit/bb7783e295506ad423f527ed28a019836e331e8c); the fork itself started from a slightly newer `main`.
After each rebase, rerun the outbound check and review anything new.

## License

MIT, as upstream. See [LICENSE](./LICENSE).

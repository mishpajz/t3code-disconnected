# t3code-disconnected

A fork of [T3 Code](https://github.com/pingdotgg/t3code) for networks where software may
not send data to outside services. The server, web UI, desktop app and orchestration stay
as they are. Only the code that talks to servers other than the ones you point it at is
removed or turned off.

## Scope

This fork cares about the **desktop app**: `apps/desktop`, the server it bundles
(`apps/server`, also run on its own with `t3 serve` on worker machines), and `apps/web` as the
desktop app's UI. The hosted web app (app.t3.codes), the mobile app (`apps/mobile`) and the
marketing site (`apps/marketing`) are left as upstream has them. They are not tested or
patched, beyond what is needed to keep the build working.

## Goals

- **No calls home.** No analytics, update checks, version checks or downloads from T3,
  npm, GitHub or other third-party hosts unless you start them yourself.
- **No VPN-like software.** Nothing in the build installs, downloads or runs tunnel or VPN
  clients (cloudflared, Tailscale). Remote access uses whatever transport you already
  have, such as [Microsoft Dev Tunnels](#remote-access-over-dev-tunnels).
- **Easy to keep up with upstream.** Changes are small and gated in place so rebases stay
  cheap. Subsystems are switched off at their entry points rather than deleted.

## The disconnected switch

[`packages/contracts/src/disconnected.ts`](./packages/contracts/src/disconnected.ts) holds the
master `DISCONNECTED` constant, in contracts so settings defaults can follow it
(`PROVIDER_UPDATE_CHECKS_DEFAULT`).
[`packages/shared/src/disconnected.ts`](./packages/shared/src/disconnected.ts) holds the
per-feature gates derived from it (`T3_CONNECT_ENABLED`, `TAILSCALE_ENABLED`,
`ANALYTICS_ENABLED`, `DESKTOP_AUTO_UPDATE_ENABLED`, `BITBUCKET_ENABLED` and those listed under
[Patched to stay local](#patched-to-stay-local)). Each gate is ANDed into upstream's own
switch for the feature, so no build value, environment variable, setting or stored secret can
turn it back on. Defaults only change what a fresh install starts with; users can still opt
in. Fork patches are marked with a `t3code-disconnected:` comment; tests that cover upstream's
enabled behaviour are skipped or force the gate on.

## Non-goals

- **Agents and their vendors.** The coding agents you run (Copilot CLI, Claude, Codex and so
  on) talk to their own services. This fork does not change that; use the ones you are
  allowed to use.
- **Git hosting and source-control integrations.** These talk to the hosts you configure
  (for example Azure DevOps through `az`). They stay, except Bitbucket, which contacts
  `api.bitbucket.org` on its own and is not needed here.
- **The built-in browser.** It can still download Chrome on first use and browse wherever
  you or an agent navigate.
- **Web content in chat and pull requests.** Images, audio and video embedded in messages or
  pull request descriptions load like any page you browse. Link and tool favicons and
  provider-supplied logos load too; favicons for links come from Google's favicon service
  (`packages/shared/src/favicon.ts`).
- **Hosted web app and mobile app.** See [Scope](#scope). The mobile app also depends on
  T3 Connect for push notifications.

## Changes

### Disabled by the disconnected switch

- [x] **T3 Connect.** The cloud relay, account linking, managed endpoints, agent-activity
      publishing, held-webhook wake-ups and guest links, whose setting and share actions are
      hidden (`apps/server/src/cloud`, `apps/server/src/relay`,
      `packages/client-runtime/src/relay`, `apps/web/src/components/chat/guestShareAvailability.ts`).
- [x] **cloudflared.** Downloaded and run only for T3 Connect (`packages/shared/src/relayClient.ts`).
- [x] **Clerk sign-in.** Only used by T3 Connect (`apps/web/src/components/clerk`,
      `apps/desktop/src/app/DesktopClerk.ts`).
- [x] **Tailscale integration.** It never installs Tailscale, but it runs the `tailscale`
      command when network access or Tailscale Serve is on (`packages/tailscale`,
      `apps/desktop/src/backend/tailscaleEndpointProvider.ts`,
      `apps/server/src/environment/DirectEndpoints.ts`).
- [x] **Bitbucket integration.** It checks sign-in against `api.bitbucket.org` whenever source
      control settings load, even with no token configured. Its server driver is left out, so
      Bitbucket is not listed and Bitbucket remotes read as unsupported
      (`apps/server/src/sourceControl/sourceControlDefinitions.ts`).

### Turned off by default

- [x] **Product analytics** (PostHog at `ingest.t3.codes`): forced off by
      `ANALYTICS_ENABLED`, even with `T3CODE_TELEMETRY_ENABLED=true`
      (`apps/server/src/telemetry/AnalyticsService.ts`).
- [x] **Desktop auto-update checks** against GitHub releases: forced off by
      `DESKTOP_AUTO_UPDATE_ENABLED`; the updater reports itself disabled and never checks
      (`apps/desktop/src/updates/DesktopUpdates.ts`).
- [x] **Model list download** from GitHub and **provider version checks**:
      `enableProviderUpdateChecks` defaults to `false` and can be turned on in
      **Settings → Maintenance** (`packages/contracts/src/settings.ts`,
      `apps/server/src/provider/ModelManifest.ts`). Updating a provider from Settings still
      looks up its latest version, since you start that yourself.
- [x] **OpenTelemetry export**: stays unconfigured; no endpoints are baked into builds. The
      only build-time OTLP endpoint is for relay tracing, which is off with T3 Connect. Export
      to a receiver you configure in **Settings → General → Diagnostics** still works.

### Patched to stay local

- [x] **npm version check** from the web UI every five minutes: never runs, so no npm-driven
      update prompt appears (`NPM_RELEASE_CHECK_ENABLED`, `apps/web/src/state/npmRelease.ts`).
- [x] **CLI self-update and runtime downloads** (`RUNTIME_DOWNLOADS_ENABLED`): `t3 update` and
      server self-update report that they are disabled; server update notices ask you to install
      the matching build instead of copying an `npm`/`npx` command that would fetch upstream; the
      npm launcher and background service only start a runtime that is already installed; SSH
      environments run the `t3` already on the remote host's `PATH` and fail with install
      instructions if there is none; the startup error screen suggests `t3 triage` instead of
      `npx t3 triage` and has no link to reinstall from t3.codes (`apps/server/src/cli/update.ts`,
      `apps/server/src/cloud`, `apps/web/src/components/ServerUpdateAction.tsx`,
      `apps/web/src/lib/bootError.ts`, `scripts/npm-launcher`, `packages/ssh/src/tunnel.ts`).
- [x] **LiteLLM pricing** fetched from GitHub: usage costs use a bundled snapshot of the rates
      instead, even on refresh (`REMOTE_PRICING_ENABLED`,
      `apps/server/src/usage/usageBundledRates.ts`). Price overrides and provider-reported
      costs still apply.
- [x] **ACP registry**: local ACP commands only, no registry index, package downloads or CDN
      icons (`ACP_REGISTRY_ENABLED`, `packages/provider-acp-registry`,
      `apps/web/src/components/settings/AcpRegistryIcon.tsx`).
- [x] **Theme marketplace** (open-vsx.org): hidden; importing theme files still works
      (`THEME_MARKETPLACE_ENABLED`, `apps/web/src/openVsxThemes.ts`).
- [x] **Prompt links** to app.t3.codes: the **Copy prompt link** button on messages and the
      command palette's copy prompt link actions are hidden, since opening such a link sends
      the prompt to T3's hosted app (`PROMPT_LINKS_ENABLED`,
      `apps/web/src/components/promptLinks/copyPromptLink.ts`).
- [x] **Cloud VM check**: a background service with no `T3CODE_HOST` no longer connects to the
      cloud metadata address `169.254.169.254` to decide whether to hide its LAN addresses, so
      it always lists them (`CLOUD_METADATA_PROBE_ENABLED`,
      `apps/server/src/environment/DirectEndpoints.ts`).

### Other changes

- [ ] **Copilot launched through a wrapper.** Copilot-specific handling (nested subagents)
      also applies when Copilot is started through a wrapper executable, not only one named
      `copilot` (`packages/provider-acp-registry/src/server/adapter.ts`).
- [x] **Own desktop app identity.** Packaged builds install as **T3 Code Disconnected**, app ID
      `com.t3tools.t3code.disconnected`, in their own folder (`%LOCALAPPDATA%\Programs\t3code-disconnected`
      on Windows) with their own profile folder (`t3code-disconnected`). With upstream's identity,
      Windows and package managers treat the fork as upstream T3 Code, upstream's installer or
      updater can replace it, and a running upstream app takes over its window. The profile
      starts empty and is not copied from upstream's `t3code-v2`. Threads and projects in
      `~/.t3` are shared as before (`DESKTOP_OWN_APP_IDENTITY`, `scripts/build-desktop-artifact.ts`,
      `apps/desktop/src/app/DesktopUserData.ts`).
- [x] **Egress check.** Runs the server and web UI with no route to the internet and
      records every DNS lookup and connection attempt ([`egress-check/`](./egress-check/README.md)).
      Runs before every Windows installer build.
- [x] **Source check script.** Lists outbound URLs and tunnel or VPN tool names in the
      source, to catch calls the egress check doesn't exercise, and fails on any not in its
      reviewed baseline ([`egress-check/source-check.mjs`](./egress-check/README.md#source-check)).
      Runs in Disconnected CI.

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
After each rebase, run `egress-check/check.sh` and `node egress-check/source-check.mjs`
and review anything new.

## CI and builds

Upstream's workflows are **disabled in the repository settings**, not deleted, so rebases
don't conflict on them. They need upstream's Blacksmith runners and secrets, and their deploy
and publish jobs only run in `pingdotgg/t3code`. Workflows that upstream adds later start out
enabled; check the Actions tab after a rebase and disable any new ones with
`gh workflow disable <name>`.

The fork's own workflows run on GitHub-hosted runners and are prefixed `disconnected-`:

| Workflow                             | Runs on                                                      | What it does                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `disconnected-ci.yml`                | Pull requests and pushes to `main`, except docs-only changes | Lint, source check, build and typecheck, and tests for the desktop scope                                      |
| `disconnected-windows-tests.yml`     | Manual                                                       | Tests on Windows, for the whole repo or one package                                                           |
| `disconnected-windows-installer.yml` | Manual                                                       | Runs the egress check, then builds the Windows x64 installer and attaches it to the run; nothing is published |

The Windows installer is built without T3 Connect, Clerk or relay configuration, without an
auto-update feed, and without the WSL runtime. It is **unsigned**.

## License

MIT, as upstream. See [LICENSE](./LICENSE).

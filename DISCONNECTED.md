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

Upstream's [managed policy](./docs/user/managed-policy.md) works as upstream has it and reads
the same policy locations. It cannot turn back on anything a gate switches off: a policy that
allows T3 Connect, usage data or updates does not re-enable them. It can still lock settings the
fork only defaults off, such as `enableProviderUpdateChecks`. A policy that keeps clients local
does not remove Tailscale Serve routes, since the fork never runs `tailscale`; remove them
yourself. Admins who also run upstream builds can still set `connect`, `telemetry` and
`updates.mode` to cover those. To also lock provider update checks off, deploy a policy such
as this at `C:\Program Files\T3Code\policy.json` (or the `HKLM\SOFTWARE\Policies\T3Tools\T3Code`
key). Leave out `limits.clients` on workers that accept Dev Tunnel connections, since a policy
without `remote` keeps the server on loopback and revokes remote pairings.

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "settings": { "enableProviderUpdateChecks": { "value": false, "locked": true } },
  "limits": {
    "connect": false,
    "telemetry": false,
    "updates": { "mode": "off", "allowNightly": false }
  }
}
```

## Non-goals

- **Agents and their vendors.** The coding agents you run (Copilot CLI, Claude, Codex and so
  on) talk to their own services. This fork does not change that; use the ones you are
  allowed to use. That includes the usage and quota lookups T3 Code makes for a provider you
  turned on and signed in to, with that provider's own sign-in (for example Claude's reset
  credits on `api.anthropic.com` and Antigravity's quotas on `googleapis.com`).
- **Git hosting, issue trackers and source-control integrations.** These talk to the hosts
  you configure (for example Azure DevOps through `az`, Linear once you add its API key, or
  TanStack Source once you turn on its `tanstack_source` feature flag). Workflows, off by
  default, poll the issue and pull request hosts their triggers name. They stay, except
  Bitbucket, which contacts `api.bitbucket.org` on its own and is not needed here.
- **The built-in browser.** It can still download Chrome on first use and browse wherever
  you or an agent navigate.
- **Web content in chat, pull requests and issues.** Images, audio and video embedded in
  messages and in pull request and issue descriptions load like any page you browse, as do
  their authors' avatars. Link and tool favicons and provider-supplied logos load too; favicons for links come from Google's favicon service
  (`packages/shared/src/favicon.ts`). Azure DevOps links use the bundled Azure DevOps icon
  instead, so your organization's host is not sent to Google.
- **Model APIs you configure.** Text generators and cloud dictation send requests to the
  OpenAI, Anthropic, OpenRouter or xAI endpoint you set up, and opening OpenRouter's dictation
  settings lists its models. HTTP quota sources poll the URL you give them.
- **Apple Speech on macOS.** When you pick Apple Speech, macOS may download the language
  model from Apple the first time you dictate in that language. Windows builds don't have it.
- **Callbacks that MCP clients register.** A signed-in outside MCP client can subscribe to
  thread events with a callback URL of its choosing, and T3 Code posts events there.
- **Hosted web app and mobile app.** See [Scope](#scope). The mobile app also depends on
  T3 Connect for push notifications.

## Changes

### Disabled by the disconnected switch

- [x] **T3 Connect.** The cloud relay, account linking, managed endpoints, agent-activity
      publishing, held-webhook wake-ups and guest links, whose setting and share actions are
      hidden, as is the relay admin permission when creating a pairing link (`apps/server/src/cloud`, `apps/server/src/relay`,
      `packages/client-runtime/src/relay`, `apps/web/src/components/chat/guestShareAvailability.ts`).
- [x] **cloudflared.** Downloaded and run only for T3 Connect (`packages/shared/src/relayClient.ts`).
- [x] **Clerk sign-in.** Only used by T3 Connect (`apps/web/src/components/clerk`,
      `apps/desktop/src/app/DesktopClerk.ts`).
- [x] **Tailscale integration.** It never installs Tailscale, but it runs the `tailscale`
      command when network access or Tailscale Serve is on, and at startup when a managed
      policy keeps clients local, to turn off Serve routes to the server (`packages/tailscale`,
      `apps/desktop/src/backend/tailscaleEndpointProvider.ts`,
      `apps/server/src/environment/DirectEndpoints.ts`, `apps/server/src/server.ts`).
- [x] **Bitbucket integration.** It checks sign-in against `api.bitbucket.org` whenever source
      control settings load, even with no token configured. Its server driver is left out, so
      Bitbucket is not listed and Bitbucket remotes read as unsupported
      (`apps/server/src/sourceControl/sourceControlDefinitions.ts`).

### Turned off by default

- [x] **Product analytics** (PostHog at `ingest.t3.codes`): forced off by
      `ANALYTICS_ENABLED`, even with `T3CODE_TELEMETRY_ENABLED=true`; **Settings → About** and the
      Welcome page no longer say usage data is collected. **Agent feedback**, which sends agents' reports to
      the T3 team through analytics, is hidden from **Settings → Labs** and stays off even when
      a saved setting turns it on, so agents get no feedback tool or instructions
      (`apps/server/src/telemetry/AnalyticsService.ts`, `apps/server/src/serverSettings.ts`,
      `apps/web/src/components/settings/SettingsPanels.tsx`).
- [x] **Desktop auto-update checks** against GitHub releases: forced off by
      `DESKTOP_AUTO_UPDATE_ENABLED`; the updater reports itself disabled and never checks, and
      the window shown when the app cannot start asks you to install a fork build instead of
      linking to upstream's releases (`apps/desktop/src/updates/DesktopUpdates.ts`,
      `apps/desktop/src/app/DesktopStartupRecovery.ts`).
- [x] **Model list download** from GitHub and **provider version checks**:
      `enableProviderUpdateChecks` defaults to `false` and can be turned on in
      **Settings → Maintenance** (`packages/contracts/src/settings.ts`,
      `apps/server/src/provider/ModelManifest.ts`). Updating a provider from Settings still
      looks up its latest version, since you start that yourself.
- [x] **OpenTelemetry export**: stays unconfigured; no endpoints are baked into builds. The
      only build-time OTLP endpoint is for relay tracing, which is off with T3 Connect. Export
      to a receiver you configure in **Settings → Maintenance → Diagnostics** still works.

### Patched to stay local

- [x] **npm release lookups**: the server never runs `npm view` or asks the public npm registry
      for `t3` releases, so no npm-driven update prompt appears, and **Settings → About** has no
      Stable/Nightly update track switch (`NPM_RELEASE_CHECK_ENABLED`,
      `apps/server/src/cloud/npmRelease.ts`, `apps/web/src/state/npmRelease.ts`).
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
- [x] **ACP registry**: local ACP commands only, no registry index (not even in background
      provider checks), browsing from the Welcome page, package downloads or CDN icons (`ACP_REGISTRY_ENABLED`, `packages/provider-acp-registry`,
      `apps/web/src/components/settings/AcpRegistryIcon.tsx`).
- [x] **Theme marketplace** (open-vsx.org): hidden; importing theme files still works
      (`THEME_MARKETPLACE_ENABLED`, `apps/web/src/openVsxThemes.ts`).
- [x] **Prompt links** to app.t3.codes: the **Copy prompt link** button on messages and the
      command palette's copy prompt link actions are hidden, since opening such a link sends
      the prompt to T3's hosted app. Pairing links for HTTPS endpoints point at the server
      itself instead of app.t3.codes, which would receive the endpoint (`PROMPT_LINKS_ENABLED`,
      `apps/web/src/components/promptLinks/copyPromptLink.ts`,
      `apps/web/src/components/settings/pairingUrls.ts`).
- [x] **Triage downloads**: opening a triage draft no longer looks up and clones upstream's
      source from GitHub in the background, and the triage playbook no longer tells the agent
      to fetch a newer copy of itself; the agent asks before cloning the source, like any other
      download (`TRIAGE_UPSTREAM_FETCH_ENABLED`, `apps/server/src/triage`).
- [x] **Device tools**: the Device panel no longer installs `agent-device` and `expo-device-hub`
      from npm on first use, locally or on an SSH device host (including when a Simlock host
      lists its devices); its error gives the `npm install` command to run yourself
      (`RUNTIME_DOWNLOADS_ENABLED`, `apps/server/src/device/DeviceToolchain.ts`,
      `apps/server/src/device/sshDeviceScript.ts`).
- [x] **GitHub star prompt**: after a few prompts, upstream checks on `api.github.com` whether
      your GitHub account starred `pingdotgg/t3code` and then asks for a star. Neither runs
      (`GITHUB_STAR_PROMPT_ENABLED`, `apps/web/src/components/GitHubStarPrompt.tsx`).
- [x] **Codex runtime upgrades at startup**: a T3-managed Codex install older than the build's
      pinned release is no longer downloaded over on startup; it keeps running until you update
      it from **Settings** (`RUNTIME_DOWNLOADS_ENABLED`,
      `apps/server/src/provider/CodexInstallation.ts`).
- [x] **Speech model downloads**: recording no longer downloads the Silero voice activity model
      from Hugging Face when it is missing; it uses an installed copy or raw audio. Downloading a
      model in **Settings** still fetches it, since you start that yourself
      (`RUNTIME_DOWNLOADS_ENABLED`, `apps/server/src/speech/SpeechService.ts`).
- [x] **Cloud VM check**: a background service with no `T3CODE_HOST` no longer connects to the
      cloud metadata address `169.254.169.254` to decide whether to hide its LAN addresses, so
      it always lists them (`CLOUD_METADATA_PROBE_ENABLED`,
      `apps/server/src/environment/DirectEndpoints.ts`).

### Custom providers

Providers the fork adds on top of upstream's. They run only the CLI the user configures.

- [x] **GitHub Copilot provider.** A dedicated `copilot` driver runs the user's Copilot CLI (or
      a wrapper that launches it) through the official Copilot SDK, one CLI per provider
      instance and one Copilot session per thread, sharing `~/.copilot`. It supports steering,
      Stop, queued messages, conversation rewind on checkpoint revert, plan mode with proposed
      plans, questions, native allow-all for **Full access**, subagent child threads (background
      ones outlive their turn and wake the thread when they finish), native forks, long-context model tiers, project skills (offered in the composer and sent as
      Copilot's own `/skill` expansion) and MCP servers (T3 trusts each folder it opens in
      Copilot), compaction rows and manual `/compact`, the request allowance under **Usage →
      Limits**, stopping a single subagent, text generation in deleted, unindexed sessions, and
      Usage history under its own **GitHub Copilot** source (`copilot-usage/<day>.jsonl` in the
      state directory). It does not depend on the ACP Registry. T3 always passes the configured
      executable, so the SDK's bundled CLIs are never used: pnpm skips them
      (`ignoredOptionalDependencies`) and desktop packaging excludes them. Copilot's built-in
      GitHub MCP server and session telemetry are turned off in its sessions. A managed policy
      names it `copilot`; a policy that locks its instance pin, or pins it under a runtime-mode
      ceiling, also holds **Hide GitHub tokens** off, so the tokens it pins reach Copilot. Usage prices
      Copilot's dotted Claude versions at the dashed rates, so the bundled rates include
      `claude-sonnet-4-5` (`packages/provider-copilot`,
      [user guide](./docs/user/providers-copilot.md)).

### Other changes

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

Then use **Settings → Environments → Add environment** with `http://127.0.0.1:4771` and the
pairing code. Repeat for each worker, and turn on **Load balancing** to spread new threads
across them.

[`dev-tunnels/`](./dev-tunnels/README.md) has PowerShell scripts that run the worker's server
and tunnel, and the control machine's tunnel connections, in the background.

## Staying in sync with upstream

```bash
git fetch upstream
git rebase upstream/main
```

`upstream` is fetch-only in this clone (`git remote set-url --push upstream no-push`).

The list of outbound calls above comes from an audit of upstream at commit
[`bb7783e`](https://github.com/pingdotgg/t3code/commit/bb7783e295506ad423f527ed28a019836e331e8c); the fork itself started from a slightly newer `main`. It was re-audited after rebasing onto
upstream `v0.1.10`, `v0.1.11` and `v0.1.12`.
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

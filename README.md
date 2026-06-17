# Multiplayer IDE

Local-first collaborative AI coding prototype: parallel, isolated Claude coding sessions on a host laptop. Each session has its own sandbox container, its own git worktree, single-writer ownership with HMAC capabilities, and a global-locked merge into `main`. Remote collaborators join over a Socket.IO relay on the LAN.

For architecture, wire protocol, and design notes, read [`HANDOFF.md`](./HANDOFF.md).

---

## Prerequisites

Install these on the host before running the servers:

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | tested on 20.x and 25.x |
| npm | ≥ 10 | ships with Node |
| git | any recent | required for the worktree-per-session model |
| podman | ≥ 4 | rootless; required only when `COLLAB_AGENT=claude` (Claude tool calls run inside containers). Not needed for scripted mode. |
| openssl | any | optional; used to seed the host token. Falls back to Node `crypto` if absent. |

macOS install (Homebrew):

```bash
brew install node git podman
podman machine init && podman machine start   # one-time, podman only
```

Linux (Debian/Ubuntu):

```bash
sudo apt install nodejs npm git podman
```

You also need an Anthropic credential **only** if you want the real Claude agent. Skip this for scripted mode.

- `CLAUDE_CODE_OAUTH_TOKEN` — `sk-ant-oat01-…` (OAuth/OAT, recommended)
- `ANTHROPIC_API_KEY` — `sk-ant-api…` (raw API key)
- `ANTHROPIC_AUTH_TOKEN` — generic bearer

---

## Install & build

```bash
npm install
npm run build
```

`npm run build` compiles `packages/shared → relay → daemon` via TypeScript project references. The client is plain HTML/JS and needs no build step.

---

## Run the servers

### With Claude (real agent)

```bash
CLAUDE_CODE_OAUTH_TOKEN='your-oat-token' bash scripts/run.sh
```

Starts three processes:

- **relay** — `:4000` (Socket.IO, binds `0.0.0.0` so other LAN devices can connect)
- **daemon / admin HTTP** — `127.0.0.1:4100` (loopback-only)
- **client UI** — `:5173` (binds `0.0.0.0`)

The script prints the LAN URL it derives from your active interface, e.g.:

```
client UI:       http://192.168.1.11:5173
```

Share that URL on your LAN. Ctrl-C stops all three children.

First-run side effects (idempotent):

- `~/.local-collab/host-token` — persisted host/admin token (mode 600). Same token survives restarts so existing invites keep working.
- `~/.local-collab/sample-repo` — sandbox git repo, created only if `COLLAB_REPO_ROOT` is unset.
- `~/.local-collab/secret` — HMAC secret for capability tokens (mode 600).

### Without Claude (scripted mode)

No credential needed. The scripted agent runs canned JSON actions instead of calling the SDK, and containers are skipped.

```bash
COLLAB_AGENT=scripted bash scripts/run.sh
```

### Background with a log file

```bash
CLAUDE_CODE_OAUTH_TOKEN='your-oat-token' \
  bash scripts/run.sh > ~/.local-collab/collab.log 2>&1 &
disown
```

### Stop

```bash
pgrep -fl "node packages/(relay|daemon|client)" | awk '{print $1}' | xargs -r kill
```

---

## Useful environment variables

| Var | Default | Meaning |
|---|---|---|
| `COLLAB_AGENT` | `claude` if any Anthropic env var is set, else `scripted` | Agent backend. |
| `COLLAB_REPO_ROOT` | `~/.local-collab/sample-repo` | Host repo whose worktrees back each session. Point this at a real project to drive it. |
| `COLLAB_RELAY_PORT` | `4000` | Relay listen port. |
| `COLLAB_ADMIN_PORT` | `4100` | Daemon admin HTTP port (loopback). |
| `CLIENT_PORT` | `5173` | Client static server port. |
| `COLLAB_CONTAINER_IMAGE` | `node:20-bookworm` | Image used per session container. |
| `COLLAB_CREATE_CONTAINERS` | `true` for `claude`, `false` otherwise | Set to `false` to skip podman entirely (Claude tool calls will fail). |

The `scripts/admin.sh` wrapper around the daemon admin API (`create`, `invite`, `publish`, `delegate`, `end`) reads `COLLAB_HOST_TOKEN` from `~/.local-collab/host-token` if exported. See the script for usage.

---

## Tests

```bash
npm test
```

Vitest, no network, no podman required.

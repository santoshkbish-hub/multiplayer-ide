# Local-First Collaborative AI Coding — Handoff

A prototype that runs **parallel, isolated AI coding sessions** on a host laptop. Each session has its own sandbox container, its own git worktree on a durable branch, single-writer ownership with HMAC capabilities, mount-shaped permissions, and a global-locked merge into `main`. Remote collaborators connect over a Socket.IO relay.

This doc is the cold-start brief for the next agent. Read it end to end before touching code — there are several non-obvious quirks below the surface (mount semantics, publish vs. checkpoint, SDK session resume, OAT vs API key, etc.) that have already burned hours.

---

## Quick start

```bash
# One-shot launcher (relay + daemon + client).
# Persists a host token at ~/.local-collab/host-token.
# Auto-creates a sample repo at ~/.local-collab/sample-repo if COLLAB_REPO_ROOT is unset.
# Picks COLLAB_AGENT=claude if any Anthropic credential env var is set, else scripted.
CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-…' bash scripts/run.sh > ~/.local-collab/collab.log 2>&1 &

# Then open http://192.168.1.11:5173 (LAN URL is printed in the log).
```

- `npm run build` — compiles `shared` → `relay` → `daemon` via project references.
- `npm test` — vitest suite (currently 53 tests, all green).
- The daemon's admin port (`:4100`) is loopback-only; the relay (`:4000`) and client (`:5173`) bind `0.0.0.0`.

### Credential gotcha

The Claude Agent SDK reads three env vars and picks the first set:

| Var | Format |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-api…` (raw API key, sent as `x-api-key`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | `sk-ant-oat…` (OAuth/OAT, sent as `Authorization: Bearer …`) |
| `ANTHROPIC_AUTH_TOKEN` | generic bearer |

**Putting an OAT token in `ANTHROPIC_API_KEY` returns "Invalid API key".** This bit us once. Both `scripts/run.sh:60` and `packages/daemon/src/config.ts:42` check all three for "any credential present → use Claude agent".

### User's stated preferences / guardrails (durable)

- Don't persist provided API tokens into new files on disk. The user pastes a temp OAT and means "use it for this run". Inline `KEY=value command` is fine; writing `~/.local-collab/anthropic-key` is not (classifier will deny it anyway).
- Don't write tokens into `/tmp` logs (world-readable risk). Use `~/.local-collab/collab.log` (the data dir is 700 and already private).
- The user pushes back hard on speculative or hedged claims. When something looks broken, **read the code path and verify** before answering. Don't reassure.
- Terse, concrete responses. End-of-turn summary should be one or two sentences plus a concrete next action they can run.

---

## Architecture (one screen)

```
Browser (LAN)            Relay (socket.io)            Daemon
  app.js                   router.ts                    orchestrator.ts
   │                        │                            ├── SessionManager (sqlite)
   │ HTTP /api/join         │                            ├── CapabilityIssuer (HMAC)
   ├──────► client/server.js                             ├── GitManager + GitSync (worktrees, --ff-only)
   │       (proxies to daemon admin :4100)               ├── PolicyResolver (mount plan)
   │                                                     ├── PodmanContainerManager (rootless)
   │ WS handshake { kind: "client", token: invite }      ├── ClaudeAgent (SDK + MCP container tools)
   ├──────► relay/auth.ts ──────► socket.data           ├── AgentLoop (per-prompt runner + checkpoint)
   │       (validates invite, joins room=session_id)    ├── MergeManager (async-mutex on main, publish)
   │                                                     ├── FileWatcher (fs.watch → files.changed)
   │ event:"event" {WireEvent}                          ├── RelayClient (long-lived socket as daemon)
   ├────────────────────────────► relay routes ──────► daemon socket
   │                              by room + role
   │ ◄────  event:"event" (rebroadcast / daemon emit)
   │ ◄────  event:"replay" (chat+events bundle)
```

### Packages

- **`packages/shared`** — TS types only, no runtime deps. Wire events, capability shape, policy/mount types, `DEFAULT_POLICY`.
- **`packages/relay`** — Socket.IO server. `io.use()` middleware verifies tokens; `router.ts` enforces the per-event allow-table.
- **`packages/daemon`** — Everything else: sqlite store, sessions, capabilities, git, mounts, containers, agent loop, merge, watchers, admin HTTP.
- **`packages/client`** — Vanilla HTML/JS UI served by a tiny Node static server. Proxies a `/api/join` HTTP call to daemon admin for session provisioning, then opens a WS to the relay.

---

## Wire protocol (current state)

Events flow over Socket.IO as `event: "event"` with a `WireEvent` payload. The exhaustive list is `packages/shared/src/events.ts`. Relay enforcement is in `packages/relay/src/router.ts`.

| Type | Direction | Allowed by relay from |
|---|---|---|
| `chat.message` | both | clients (rebroadcast), daemon |
| `presence.update` | both | client connect/disconnect, daemon emit ok |
| `cursor.update` | client→all | clients |
| `agent.prompt` | client→daemon | **owner only**, forwarded to daemon |
| `command.request` | client→daemon | **owner only** |
| `agent.token` | daemon→room | daemon emit |
| `command.output` | daemon→room | daemon emit |
| `owner.changed` | daemon→room | daemon emit |
| `publish.status` | daemon→room | daemon emit |
| `session.ended` | daemon→room | daemon emit (relay then disconnects the room) |
| `files.changed` | daemon→room | daemon emit (from FileWatcher) |
| `error` | daemon→room | daemon emit |

**Replay on reconnect.** Handshake auth carries `since_chat_seq` / `since_event_seq`. Relay forwards a `client.hello` to daemon. Daemon computes `Replay.bundle()` and the relay delivers it as `event: "replay"` to that specific socket only. Implemented end to end.

---

## Sessions, capabilities, ownership

- Each `(user)` provisioned via `/api/join` gets a **new session** (see `packages/client/server.js:50`). One user = one session in this prototype's UI.
- Session metadata in sqlite (`packages/daemon/src/store/sessions.ts`): `session_id`, `branch_name = collab/session-<id>`, `worktree_path`, `owner_user_id`, `owner_epoch`, `policy`, `status`.
- Capabilities are HMAC-SHA256 over `{session_id, user_id, role, scope, owner_epoch, exp}` using a secret persisted at `~/.local-collab/secret` (mode 600). See `packages/daemon/src/session/capability.ts`.
- **Owner delegation bumps `owner_epoch`** in the same txn that issues the new capability. Pending prompts attributed to the prior epoch are rejected with `epoch_stale`. Revocation is fan-out: ALL invites in the session get revoked; the new owner gets a fresh invite + capability.
- `session.ended` is emitted, the room is disconnected, the container is destroyed, watcher is detached.

---

## Git lifecycle

- One durable branch per session: `collab/session-<id>`. Created with `git worktree add -b … ../collab-worktrees/<id> main`.
- `AgentLoop.runOne` (`packages/daemon/src/agent/loop.ts`) calls a `git checkpoint <prompt_id>` at the end of every turn. **Checkpoint ≠ publish.** It's a local commit on the session branch with `user.email=daemon@local`.
- `GitSync.check` runs every N agent events (`syncEvery`, default 8) and after each turn — flags `stale` when main has advanced over an overlapping file.

### Publish — what it actually does

`orchestrator.publish` first checkpoints the session worktree (`git add -A && commit` if dirty) before calling `MergeManager.publish`. This matters for the SDK publish tool: the agent calls publish inside the same turn, before `AgentLoop.runOne` reaches its end-of-turn checkpoint, so publish must materialize uncommitted `/work` edits into the session branch first.

`packages/daemon/src/merge/manager.ts:53` (`MergeManager.publish`). Under a process-global `async-mutex`:

1. **start** — emit.
2. **sync** — `merge-base + name-only diff` to check staleness. Fail → `stale`.
3. **validate** — `git diff --name-only main..<branch>`. **If zero files → fail `nothing_to_publish`.** This guard was added after a real bug: container writes to unmounted paths used to vanish, and publish would silently merge an empty no-ff. Then re-validate each path against policy (`deny` wins, must be in `write_allow`). Fail → `denied_path` / `invalid_path`.
4. **checks** — runs each `command_allow` entry matching `npm test|npm run|*lint*` via an optional `runCheck` injected for tests (production path is currently no-op — see TODOs).
5. **merge** — `git checkout main && git merge --no-ff -m "merge <branch>" <branch>` in the repo root. Failure aborts and reports `merge_conflict`.

After a successful publish, `orchestrator.publish` (`packages/daemon/src/orchestrator.ts:266`):

- Fast-forwards the publisher's worktree branch to main via `GitManager.syncBranchToMain` → `git merge --ff-only main` inside the worktree. The session branch keeps tracking main so the next checkpoint is rooted on the merge commit.
- **Fan-out:** `syncSiblingSessionsToMain` walks every other active session's worktree and `--ff-only`s it too. Each successfully-synced worktree emits an fs event the `FileWatcher` translates into `files.changed`, so other connected UIs refresh automatically. Sessions with their own in-progress commits stay stale (we emit a `publish.status` with `reason: "non_ff"` rather than rewriting history).

### The publish tool exposed to the agent

The Claude SDK sees an MCP tool `mcp__container__publish` (`packages/daemon/src/agent/containerTools.ts`). When called, it invokes the daemon callback wired through `AgentLoop.publish` → `orchestrator.publish`. Returns merge SHA on success; on failure returns a reason string the agent can recover from. The system prompt **requires** the agent to call this when the user's requirement is satisfied (`packages/daemon/src/agent/claude.ts:113`).

`mcp__container__bash` wraps commands with `timeout -k 5s` and defaults to 60s unless the model supplies `timeout_ms` (clamped to 10 minutes). This prevents network-blocked commands such as `npx -y ...` from leaving a UI tool tile pending indefinitely.

---

## Container model — read this carefully

`PodmanContainerManager` (`packages/daemon/src/container/podman.ts`) runs rootless podman.

Default flags applied to every container:

- `--cap-drop=ALL --pids-limit=512 --memory=2g --cpus=2`
- `--network` derived from policy (`none` / `bridge` / `bridge`)
- **No `--user` override.** This is intentional. Under rootless podman the container "root" is your unprivileged host UID via the user namespace, so it can write to bind-mounted files and to `/work`. Adding `--user 1000:1000` previously caused `/work` to be unwritable (UID 1000 inside the container vs. host root remap), which the agent narrated as "permission issue" → user got confused.
- `-w /work` — the agent's working directory.

### The mount plan — this is where most bugs hide

`PolicyResolver.resolveMountPlan` (`packages/daemon/src/policy/resolver.ts`):

1. **Base mount:** `worktree → /work` as `rw`. Without this, `/work` is a podman-auto-created stub directory, and writes the agent makes to paths we didn't anticipate (e.g. `/work/foo.ts` at the root) land in the container's writable layer instead of the host worktree. `publish` then sees zero diff and silently merges nothing. Don't remove this.
2. **Overrides on top of the base** — emitted *after* so podman applies them later (mounts mask in argv order):
   - `read_allow` (but not `write_allow`) paths → `:ro` overlay bind
   - `deny` files → empty-file `:ro` overlay (`empty_ro`)
   - `deny` directories → `tmpfs` (see warning below)

### tmpfs → anonymous volume

`packages/daemon/src/container/podman.ts:51`. We emit `-v /work/secrets` (anonymous volume, no host side) **instead of** `--tmpfs /work/secrets` because on macOS+applehv, `--tmpfs` over a subpath of an existing bind mount does *not* mask the underlying host content (live test demonstrated this — host's `secrets/token` was still visible inside the container). Anonymous volumes override unambiguously, are container-writable, never touch the host fs, and auto-clean with `--rm`. Cross-platform safe.

### Built-in tool aliasing

The Claude SDK's built-in `Read` / `Edit` / `Write` / `Bash` tools are aliased to the MCP `mcp__container__*` versions (`packages/daemon/src/agent/claude.ts:187`). So **every** file/shell operation the LLM thinks it's doing actually executes via `podman exec` inside the per-session container. The host-side `canUseTool` policy gate runs first as defense in depth; the container mount plan is the real boundary.

---

## Agent (Claude SDK) integration

`packages/daemon/src/agent/claude.ts` is the production agent. `ScriptedAgent` (`packages/daemon/src/agent/scripted.ts`) is a JSON-action stub used when no Anthropic credential is present.

Critical config inside `ClaudeAgent.run`:

- `mcpServers: { container: <buildContainerToolServer> }` — defines `read`, `write`, `edit`, `bash`, `publish` (`packages/daemon/src/agent/containerTools.ts`).
- `toolAliases` redirects the built-in tool names into the MCP equivalents.
- `allowedTools` whitelists the container tools plus `Glob`/`Grep`.
- `disallowedTools` blocks `WebFetch`, `WebSearch`, `AskUserQuestion`, `ExitPlanMode`. `AskUserQuestion` was blocked because there's no UI channel to answer it; the agent would just hang forever waiting on a tool result that would never come.
- `includePartialMessages: true` enables `stream_event` deltas — the UI streams tokens character by character.
- **`resume: <sdkSessionId>`** — per collab session, we capture the SDK's `session_id` off the first message and pass it on subsequent prompts so the agent has memory across turns. Without this, every prompt was a fresh conversation and the agent would say "I have no prior actions in this session" (which was technically accurate and infuriating). Map lives in `ClaudeAgent.sdkSessionIds`.
- SDK resume is now keyed by `session_id:chat_id` when a chat id is present. Multiple chats can share one container/worktree without sharing Claude conversation memory.
- **System prompt** (`buildSystemPrompt`, `packages/daemon/src/agent/claude.ts:265`) tells the agent: `/work` is the worktree; git commands are available; **a checkpoint is not a publish**; on completion call `publish`; do not attempt `git push` / `git checkout main` / `git merge main` (those are daemon-managed); answer "did you publish?" only from a real publish-tool result.
- The system prompt also has a runtime-environment section: containers normally run with `network: none`, so the agent should not use ad hoc package-fetching commands (`npx -y ...`, `npm exec <package>`, `npm install`, `npm create`, `pnpm add`, `yarn add`) unless the user explicitly asks and policy allows network. This was added after a live turn hung on `npx -y ts-node foos.ts` inside a no-network container.
- The main-update system prompt explicitly says this is a collaborative environment: other agents may update files, so the agent should use injected file-change hints and inspect relevant recent commit messages/diffs when `main` moves.

### Dynamic context injection

`packages/daemon/src/agent/contextHooks.ts` is the generic hook helper. It wires the same provider list into both `UserPromptSubmit` (before Claude handles a user prompt) and `PostToolBatch` (after a batch of tools completes, before Claude's next model request). Providers return short text snippets; the helper joins them and sends them as SDK `additionalContext`.

`packages/daemon/src/agent/mainContext.ts` is the first provider. It is on-demand: when Claude is running, the hook compares that isolated session branch to current `main` using `GitSync.check`, reports only whether `main` advanced, which files changed on `main`, and whether any of those files overlap the session branch's own changes. It suppresses duplicate notices for the same main/base state within the daemon process. The system prompt tells Claude this is a collaborative environment and these notices are relevance hints only — do not imply the worktree was fast-forwarded or reconciled. Claude should inspect `main` with `git show` / `git diff` only if the changed file list may affect the current task.

`packages/daemon/src/agent/statusContext.ts` is the shared same-session coordination provider. Rows live in sqlite table `agent_status` via `store/agentStatus.ts`; they are session-wide and contain incremental `feed_id` (`seq`), `ts`, `agent_id`, optional `chat_id`, `kind`, and a short `message`. The provider remembers the last feed id sent per `session_id:chat_id`, injects only new rows between user prompts/tool batches, and always includes current time. Automatic rows are written for owner/chat joins, prompt starts, file-edit tool uses, command tool uses, and checkpoints. Claude also has `mcp__container__status` for short plan/current-work/blocker writes and `mcp__container__status_read` for manual on-demand feed reads by `after_feed_id`.

Runtime note: containers default to `node:20-bookworm`, which includes `git` and Node/npm. Session containers also bind-mount the host repo gitdir at its original absolute path, so linked worktree `.git` files resolve correctly from `/work` and `git status` / `git diff main` / `git show main` work inside the sandbox. `COLLAB_CONTAINER_IMAGE` still overrides the image when needed.

### Event mapping (SDK → AgentEvent → wire)

`mapMessage()` translates SDK message types into `AgentEvent`:

- `stream_event` with `text_delta` → `kind: "token"` (live streaming).
- `assistant` message text blocks → `kind: "token"` (deduped against streamed indexes).
- `assistant` tool_use blocks → a single structured token `[tool_use:ID:NAME] summary` for the UI tile + internal `kind: "edit"`/`kind: "command"` events the loop uses for signalling.
- `user` message with tool_result blocks → `[tool_result:ID:NAME:ok|err]\n<body>` (body truncated to 4 KB).

The orchestrator only emits user-facing tokens, the final `[done]`, and the final `[checkpoint <sha>]` line. It deliberately doesn't render `kind: "edit"`/`kind: "command"` because the tool tile already shows them with real exit status.

---

## UI

`packages/client/public/`:

- `index.html` — three-column layout: file sidebar (top half list, bottom half viewer), transcript, prompt input. Dark theme.
- `app.js` — Socket.IO client.
  - Gate screen takes a name (max 32 chars, `[a-zA-Z0-9_-]`), then shows active daemon sessions/containers. A user can join their last local chat for a session, start a new chat in that same session/container, or create a new session/container.
  - Chat identity is `chat_id`; `session_id` still means the shared container/worktree. The browser stores recent chat ids per `user_id + session_id` in `localStorage` so returning to a session reopens the last chat by default.
  - WS auth includes `chat_id`. The transcript filters `agent.token`, `chat.message`, and chat-scoped `error` events by `chat_id`, while file/publish/presence events remain session-wide.
  - Tool tiles: tokens prefixed `[tool_use:…]` and `[tool_result:…]` become collapsible `<details>` tiles (collapsed by default; click to expand). Pending → ok / err badge.
  - File watcher: on `files.changed`, re-fetches `/api/files`; if a changed path == the currently-open file, reloads it (or clears the viewer on `unlink`).
  - Replay: on reconnect, the relay delivers a `replay` event with prior chat messages, rendered into the transcript.

`server.js`:
- Static-serves `public/`.
- Proxies `/api/sessions`, `/api/files`, and `/api/file?path=…` to daemon admin.
- `POST /api/join` either creates a new daemon session/container or joins an existing one. It issues an owner invite for the selected user so different users can run separate chats against the same session/container.
- Keeps an in-memory `chat_id -> user_id` ownership map for the UI flow: one user owns a chat, but multiple chats can point at the same session/container.

---

## Tests

`npm test` → 53 tests, all green.

- `packages/shared` — none (types only).
- `packages/relay/src/relay.test.ts` — handshake + room routing + cross-session isolation + presence broadcast filtering.
- `packages/daemon/src/agent/claude.test.ts` — policy gate (allow/deny by `canUseTool` for file paths, bash, deny-listed paths, path traversal). Uses a `fakeQuery()` that mimics the SDK.
- `packages/daemon/src/agent/agent.test.ts` — `AgentLoop` end-to-end with `ScriptedAgent`.
- `packages/daemon/src/agent/containerTools.test.ts` — direct handler tests for the MCP tools.
- `packages/daemon/src/policy/policy.test.ts` — mount plan shape.
- `packages/daemon/src/container/podman.test.ts` — argv tests + **live container acceptance** (writes/reads against actual podman; takes ~10s). Asserts: denied file shadowed, denied dir empty (anonymous volume), ro mount rejects writes, etc.
- `packages/daemon/src/git/git.test.ts` — worktree, checkpoint, syncCheck.
- `packages/daemon/src/merge/merge.test.ts` — clean publish, denied diff rejected, write-allow violation rejected, global lock serialization.
- `packages/daemon/src/resilience/resilience.test.ts` — daemon-restart rehydrate.
- `packages/daemon/src/session/session.test.ts` — capability HMAC, epoch invalidation, prompt cancellation on delegate.
- `packages/daemon/src/e2e.test.ts` — full orchestrator: create + invite + chat + agent prompt + publish + delegate + end + replay.

Important: vitest runs without `tsc -b`. Always run `npm run build` after touching type definitions to catch errors vitest misses (the container tool test caught us once with a `CallToolResult` union not handled).

---

## Recent rabbit holes (don't re-discover these)

1. **`/work` was unwritable for new top-level files.** Caused by mounting only per-subtree dirs and leaving `/work` as a podman stub with root ownership. Compounded by `--user 1000:1000`. Now: base mount of the worktree at `/work` + no `--user` override. (`packages/daemon/src/policy/resolver.ts`, `packages/daemon/src/container/types.ts:28`)

2. **Publish reported `ok=true` but main didn't move.** Same root cause — agent wrote to `/work/foo.ts`, container layer ate it, `git diff main..branch` returned empty, `git merge --no-ff` succeeded vacuously. Fixed: base mount lands writes on host AND `MergeManager` now refuses empty diffs with `nothing_to_publish`. (`packages/daemon/src/merge/manager.ts`)

3. **Agent had no memory across turns.** Every prompt opened a fresh SDK `query()`. Fixed via `resume: <sdkSessionId>` per collab session. (`packages/daemon/src/agent/claude.ts:153-209`)

4. **OAT token in `ANTHROPIC_API_KEY`** → "Invalid API key". `sk-ant-oat…` belongs in `CLAUDE_CODE_OAUTH_TOKEN`. Auto-detection now checks all three vars (`scripts/run.sh:60`, `packages/daemon/src/config.ts:42`).

5. **`--tmpfs` over a bind-mounted subpath doesn't mask on macOS applehv.** Use anonymous volumes (`-v /path` with no host side) instead. (`packages/daemon/src/container/podman.ts:51`)

6. **`AskUserQuestion` would silently hang the agent stream** waiting for an answer there's no UI for. Hard-disabled. (`packages/daemon/src/agent/claude.ts:209`)

7. **Sibling sessions saw stale code after a publish.** Each session has its own branch; only the publisher's was being ff'd. Fixed via `syncSiblingSessionsToMain` on every successful publish. The `FileWatcher` then fires `files.changed` for any worktree whose HEAD actually moved, so all connected UIs refresh. (`packages/daemon/src/orchestrator.ts:299-318`)

8. **Misleading `[cmd … ] ok=true` / `[edit …] ok` system lines** were always emitted at `tool_use` time before the tool result was in, so they always said "ok=true" regardless of actual exit. Removed — the collapsible tool tile now carries the real status from `tool_result`. (`packages/daemon/src/orchestrator.ts` `runOne` callback)

9. **Classifier blocks.** Don't write API keys to `/tmp` (world-readable) and don't persist them to new files on disk. Use `~/.local-collab/` (700) and inline env vars.

---

## Known open problems / TODOs

- **`MergeManager.runCheck` is null in production.** Tests inject a runner that mocks `npm test`. Wire up real container-exec'd checks in `orchestrator.publish` so `command_allow` lint/test entries actually gate merges.
- **Sample repo has no `package.json` / `tsconfig` / `node_modules`** at the default `~/.local-collab/sample-repo` path, so `npm test`-style checks would fail anyway. Either ship a real test target in the sample or document the policy as inspection-only.
- **No way for a non-owner to observe in the UI yet.** The capability layer supports `role: "reader"` with `scope: ["observe"]` and the relay enforces owner-only on `agent.prompt`, but the client UI provisions everyone as owner of their own session via `/api/join`. Add a "join existing session as reader" flow if you need true multi-party observation.
- **No PR-style review on publish.** `publish` is fire-and-forget by whoever is the current owner. A "request publish" → other-owner approval flow isn't built.
- **Daemon admin port is loopback only**, by design. If you ever expose it, add proper auth — it's currently a bearer-token equal to `COLLAB_HOST_TOKEN`.
- **Container image is `alpine:3.20`** (`packages/daemon/src/container/types.ts:DEFAULT_LIMITS`). No git, node, npm pre-installed inside the container. Agent's `git` / `npm` commands will exit 127. Either swap the image (e.g. `node:20-alpine`) or install tools in a baseline Dockerfile. The agent has been observed running git via the host's mounted `.git` dir but invoking the `git` binary inside the container — which works only if you change the image.
- **No structured rate limiting on `agent.prompt`.** Owner can spam.
- **`FileWatcher` uses `fs.watch({ recursive: true })`** — recursive watch is platform-dependent. Works on macOS and Windows; on Linux you may need `chokidar` if you hit kernel limits.
- **Network policy "restricted" currently behaves the same as "open"** (both `bridge`). Real restricted mode would attach a no-DNS network or allowlist egress (`packages/daemon/src/container/podman.ts:42`).
- **Tool tile body cap is 4 KB.** Larger tool outputs are truncated. If you want full body, persist to audit and link to it.

---

## File index (the 80% you'll touch)

| Concern | File |
|---|---|
| Wire events, DEFAULT_POLICY | `packages/shared/src/{events,policy}.ts` |
| Relay routing | `packages/relay/src/router.ts` |
| Relay auth / handshake | `packages/relay/src/auth.ts` |
| Daemon entry point | `packages/daemon/src/index.ts` |
| Config / env detection | `packages/daemon/src/config.ts` |
| Orchestrator (all the wiring) | `packages/daemon/src/orchestrator.ts` |
| Admin HTTP (incl. file endpoints) | `packages/daemon/src/admin.ts` |
| Sessions / capabilities | `packages/daemon/src/session/*.ts` |
| Mount plan resolver | `packages/daemon/src/policy/resolver.ts` |
| Podman manager + argv builder | `packages/daemon/src/container/podman.ts` |
| Git / worktrees / sync | `packages/daemon/src/git/{manager,sync}.ts` |
| Merge + publish gates | `packages/daemon/src/merge/manager.ts` |
| Claude agent (SDK + MCP) | `packages/daemon/src/agent/claude.ts` |
| Container-backed tools | `packages/daemon/src/agent/containerTools.ts` |
| Per-prompt loop | `packages/daemon/src/agent/loop.ts` |
| File watcher | `packages/daemon/src/files/watcher.ts` |
| Replay bundle | `packages/daemon/src/resilience/replay.ts` |
| Sqlite schema + repos | `packages/daemon/src/store/*.ts` |
| Client server (HTTP + admin proxy) | `packages/client/server.js` |
| UI markup | `packages/client/public/index.html` |
| UI logic | `packages/client/public/app.js` |
| Launcher | `scripts/run.sh` |
| Admin CLI | `scripts/admin.sh` |

---

## Conventions

- TypeScript strict, project references, ESM-only.
- No comments unless the *why* is non-obvious (a workaround, an invariant, a quirk). Don't restate what the code does.
- Discriminated unions over class hierarchies (see `WireEvent`, `AgentEvent`).
- Errors over wire: `{ type: "error", code, message, detail? }`. Codes are short snake_case identifiers (`epoch_stale`, `not_owner`, `nothing_to_publish`, …).
- Sqlite for state; in-memory `async-mutex` for the main-merge lock (single-process daemon).
- Test files colocated next to the code (`foo.ts` ↔ `foo.test.ts`).

---

## Where to start if you're picking this up

1. `bash scripts/run.sh` (with a token) and click around to see the working flow.
2. Read `packages/daemon/src/orchestrator.ts` top to bottom — it's the integration point.
3. Read `packages/daemon/src/agent/claude.ts` — most of the LLM contract lives here.
4. `packages/daemon/src/policy/resolver.ts` + `packages/daemon/src/container/podman.ts` — the mount story is the easiest place to break the security model.
5. Look at the "Recent rabbit holes" section before changing any of the above.

Good luck.

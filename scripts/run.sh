#!/usr/bin/env bash
# Boot relay + daemon + client UI with sensible defaults.
# - Persists a host token at ~/.local-collab/host-token so restarts keep the same invites.
# - If COLLAB_REPO_ROOT is unset, creates a sandbox git repo at ~/.local-collab/sample-repo.
# - Prints the LAN-accessible URL so other devices on the network can join.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATA_DIR="${HOME}/.local-collab"
mkdir -p "$DATA_DIR"

# --- token (persisted) -------------------------------------------------------
TOKEN_FILE="$DATA_DIR/host-token"
if [[ ! -s "$TOKEN_FILE" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16 > "$TOKEN_FILE"
  else
    node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))' > "$TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
  echo "generated host token → $TOKEN_FILE"
fi
export COLLAB_HOST_TOKEN
COLLAB_HOST_TOKEN="$(cat "$TOKEN_FILE")"
export RELAY_HOST_TOKEN="$COLLAB_HOST_TOKEN"
export COLLAB_ADMIN_TOKEN="$COLLAB_HOST_TOKEN"

# --- repo root --------------------------------------------------------------
if [[ -z "${COLLAB_REPO_ROOT:-}" ]]; then
  SAMPLE="$DATA_DIR/sample-repo"
  if [[ ! -d "$SAMPLE/.git" ]]; then
    echo "initializing sample repo at $SAMPLE"
    mkdir -p "$SAMPLE/src"
    git -C "$SAMPLE" init -q -b main
    git -C "$SAMPLE" config user.email "demo@local"
    git -C "$SAMPLE" config user.name "collab demo"
    cat > "$SAMPLE/src/foo.ts" <<'EOF'
export const foo = 1;
EOF
    echo "SECRET=nope" > "$SAMPLE/.env"
    git -C "$SAMPLE" add -A
    git -C "$SAMPLE" commit -q -m "init"
  fi
  export COLLAB_REPO_ROOT="$SAMPLE"
fi
echo "repo root: $COLLAB_REPO_ROOT"

# --- ports & misc -----------------------------------------------------------
export COLLAB_RELAY_PORT="${COLLAB_RELAY_PORT:-4000}"
export COLLAB_RELAY_URL="${COLLAB_RELAY_URL:-http://127.0.0.1:${COLLAB_RELAY_PORT}}"
export COLLAB_ADMIN_PORT="${COLLAB_ADMIN_PORT:-4100}"
export COLLAB_ADMIN_URL="${COLLAB_ADMIN_URL:-http://127.0.0.1:${COLLAB_ADMIN_PORT}}"
export CLIENT_PORT="${CLIENT_PORT:-5173}"
export RELAY_PORT="$COLLAB_RELAY_PORT"
export COLLAB_CONTAINER_IMAGE="${COLLAB_CONTAINER_IMAGE:-node:20-bookworm}"

# Agent selection: prefer Claude if any Anthropic credential is present.
# ANTHROPIC_API_KEY = raw API key, CLAUDE_CODE_OAUTH_TOKEN = OAuth/OAT token
# (sk-ant-oat01-…), ANTHROPIC_AUTH_TOKEN = bearer token alternative.
if [[ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
  export COLLAB_AGENT="${COLLAB_AGENT:-claude}"
else
  export COLLAB_AGENT="${COLLAB_AGENT:-scripted}"
fi

# Containers are required for COLLAB_AGENT=claude (tool calls run in podman).
if [[ "$COLLAB_AGENT" == "claude" ]]; then
  export COLLAB_CREATE_CONTAINERS="${COLLAB_CREATE_CONTAINERS:-true}"
else
  export COLLAB_CREATE_CONTAINERS="${COLLAB_CREATE_CONTAINERS:-false}"
fi

# --- build if needed --------------------------------------------------------
if [[ ! -f packages/daemon/dist/index.js || ! -f packages/relay/dist/index.js ]]; then
  echo "building TypeScript…"
  npm run --silent build
fi

# --- LAN IP for printout ----------------------------------------------------
lan_ip=""
case "$(uname -s)" in
  Darwin)
    lan_ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    ;;
  Linux)
    lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    ;;
esac
lan_ip="${lan_ip:-127.0.0.1}"

# --- start three children ---------------------------------------------------
declare -a PIDS=()
cleanup() {
  echo
  echo "shutting down…"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

echo
echo "  agent:           $COLLAB_AGENT"
echo "  containers:      $COLLAB_CREATE_CONTAINERS"
echo "  container image: $COLLAB_CONTAINER_IMAGE"
echo "  relay:           http://${lan_ip}:${COLLAB_RELAY_PORT}"
echo "  daemon admin:    http://127.0.0.1:${COLLAB_ADMIN_PORT}"
echo "  client UI:       http://${lan_ip}:${CLIENT_PORT}"
echo
echo "Share http://${lan_ip}:${CLIENT_PORT} on your LAN. Ctrl-C to stop."
echo

node packages/relay/dist/index.js &
PIDS+=($!)
# Give the relay a beat to bind so the daemon's first connect succeeds.
sleep 0.5

node packages/daemon/dist/index.js &
PIDS+=($!)
sleep 0.3

node packages/client/server.js &
PIDS+=($!)

wait

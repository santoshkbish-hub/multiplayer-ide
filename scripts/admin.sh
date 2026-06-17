#!/usr/bin/env bash
# Thin wrapper around the daemon's admin HTTP API. Requires COLLAB_HOST_TOKEN
# (or COLLAB_ADMIN_TOKEN) and COLLAB_ADMIN_URL (default http://127.0.0.1:4100).
set -euo pipefail

TOKEN="${COLLAB_ADMIN_TOKEN:-${COLLAB_HOST_TOKEN:?set COLLAB_HOST_TOKEN}}"
URL="${COLLAB_ADMIN_URL:-http://127.0.0.1:4100}"

cmd="${1:-help}"; shift || true

case "$cmd" in
  create)
    user="${1:?usage: create <owner_user_id>}"
    curl -sS -X POST "$URL/sessions" \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d "{\"owner_user_id\":\"$user\"}" | tee /dev/stderr
    echo
    ;;
  invite)
    sid="${1:?usage: invite <session_id> <user_id> [owner|reader]}"
    user="${2:?usage: invite <session_id> <user_id> [owner|reader]}"
    role="${3:-reader}"
    curl -sS -X POST "$URL/sessions/$sid/invites" \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d "{\"user_id\":\"$user\",\"role\":\"$role\"}" | tee /dev/stderr
    echo
    ;;
  publish)
    sid="${1:?usage: publish <session_id>}"
    curl -sS -X POST "$URL/sessions/$sid/publish" \
      -H "Authorization: Bearer $TOKEN" | tee /dev/stderr
    echo
    ;;
  delegate)
    sid="${1:?usage: delegate <session_id> <new_owner_user_id>}"
    new_owner="${2:?usage: delegate <session_id> <new_owner_user_id>}"
    curl -sS -X POST "$URL/sessions/$sid/delegate" \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d "{\"new_owner_user_id\":\"$new_owner\"}" | tee /dev/stderr
    echo
    ;;
  end)
    sid="${1:?usage: end <session_id> [reason]}"
    reason="${2:-ended}"
    curl -sS -X POST "$URL/sessions/$sid/end" \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d "{\"reason\":\"$reason\"}" | tee /dev/stderr
    echo
    ;;
  *)
    cat <<EOF
admin.sh — collab daemon control

  create <owner_user_id>                  Create a new session
  invite <session_id> <user_id> [role]    Issue an invite + capability (role: owner|reader)
  publish <session_id>                    Run the publish/merge pipeline for a session
  delegate <session_id> <new_owner>       Transfer ownership; issues a fresh invite + capability
  end <session_id> [reason]               End a session (destroys container, disconnects clients)

env: COLLAB_HOST_TOKEN, COLLAB_ADMIN_URL (default http://127.0.0.1:4100)
EOF
    ;;
esac

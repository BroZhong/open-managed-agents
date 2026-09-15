#!/bin/bash
# HTTP and event-stream smoke test using the mock runtime (no model call).
# Local: cd server && pnpm dev:memory (in-memory stores, no external services).
# Full backend: pnpm dev:full requires PostgreSQL, Workspace OSS and Skill
# Supabase configuration; Redis supports transient delta replay.
# Remote: set OMA_API_URL=https://agentry.welltop.tech/api and OMA_API_KEY in
# the environment. The /api prefix is required by the production ingress.

set -euo pipefail
BASE="${OMA_API_URL:-http://localhost:3000}"
BASE="${BASE%/}"
AGENT_ID=""
SESSION_ID=""
STREAM_FILE=""

api() {
  if [[ -n "${OMA_API_KEY:-}" ]]; then
    curl -fsS -H "x-api-key: $OMA_API_KEY" "$@"
  else
    curl -fsS "$@"
  fi
}

# Only remove resources created by this smoke test, including on a failed check.
cleanup() {
  if [[ -n "$STREAM_FILE" ]]; then
    rm -f "$STREAM_FILE"
  fi
  if [[ -n "$SESSION_ID" ]]; then
    api -X DELETE "$BASE/v1/sessions/$SESSION_ID" >/dev/null || true
  fi
  if [[ -n "$AGENT_ID" ]]; then
    api -X DELETE "$BASE/v1/agents/$AGENT_ID" >/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== Health Check ==="
# A 200 HTML console fallback is not a successful API health check.
api "$BASE/health" | jq -e 'select(.status == "ok")'
echo

echo "=== Create Agent ==="
AGENT=$(api -X POST "$BASE/v1/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"api-smoke-test","model":"mock-model","system":"You are a helpful assistant","runtime":"mock","sandbox":{"enabled":false}}')
echo "$AGENT" | jq .
AGENT_ID=$(echo "$AGENT" | jq -er '.id')
echo "Agent ID: $AGENT_ID"
echo

echo "=== List Agents ==="
api "$BASE/v1/agents" | jq .
echo

echo "=== Get Agent ==="
api "$BASE/v1/agents/$AGENT_ID" | jq .
echo

echo "=== Create Session ==="
SESSION=$(api -X POST "$BASE/v1/sessions" \
  -H "Content-Type: application/json" \
  -d "{\"agent\":\"$AGENT_ID\"}")
echo "$SESSION" | jq .
SESSION_ID=$(echo "$SESSION" | jq -er '.id')
echo "Session ID: $SESSION_ID"
echo

echo "=== Send Message (POST /events) ==="
api -X POST "$BASE/v1/sessions/$SESSION_ID/events" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"user.message","data":{"content":[{"type":"text","text":"Hello, agent!"}]}}]}' | jq -e 'select(.accepted == true)'
echo

echo "=== Stream Events (GET /events) ==="
echo "(Streaming SSE response...)"
STREAM_FILE=$(mktemp "${TMPDIR:-/tmp}/oma-api-smoke-stream.XXXXXX")
STREAM_STATUS=0
STREAM_METADATA=$(api --max-time 3 -N \
  --output "$STREAM_FILE" --write-out '%{http_code}\n%{content_type}' \
  "$BASE/v1/sessions/$SESSION_ID/events?include=chunks" \
  -H "Accept: text/event-stream" \
  -H "Last-Event-ID: 0") || STREAM_STATUS=$?
# Session SSE stays open after a Turn finishes. Curl's deliberate timeout is
# expected only after an HTTP 200 SSE response delivered a complete event.
if [[ "$STREAM_STATUS" -ne 0 && "$STREAM_STATUS" -ne 28 ]]; then
  exit "$STREAM_STATUS"
fi
STREAM_HTTP_STATUS="${STREAM_METADATA%%$'\n'*}"
STREAM_CONTENT_TYPE=$(printf '%s' "${STREAM_METADATA#*$'\n'}" | tr '[:upper:]' '[:lower:]')
if [[ "$STREAM_HTTP_STATUS" != "200" ]] || \
  [[ "$STREAM_CONTENT_TYPE" != "text/event-stream" && "$STREAM_CONTENT_TYPE" != "text/event-stream;"* ]]; then
  echo "SSE check failed: expected HTTP 200 and Content-Type: text/event-stream." >&2
  exit 1
fi
# Ignore retry directives, keepalive comments, and an incomplete trailing
# frame. At least one complete named event must contain valid JSON data.
if ! jq -eRs '
  gsub("\r\n"; "\n") | split("\n\n") | .[0:-1]
  | any(.[]; split("\n") as $lines
      | any($lines[]; startswith("event: ") and length > 7)
        and ([$lines[] | select(startswith("data: ")) | ltrimstr("data: ")]
             | join("\n") | try (fromjson | true) catch false))
' "$STREAM_FILE" >/dev/null; then
  echo "SSE check failed: no complete event with valid JSON data was received." >&2
  exit 1
fi
cat "$STREAM_FILE"
rm -f "$STREAM_FILE"
STREAM_FILE=""
echo
echo

echo "=== Send Event Directly ==="
api -X POST "$BASE/v1/sessions/$SESSION_ID/events" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"user.message","data":{"content":[{"type":"text","text":"direct event"}]}}]}' | jq .
echo

echo "=== Get Events (JSON) ==="
api "$BASE/v1/sessions/$SESSION_ID/events" \
  -H "Accept: application/json" | jq -e 'select(any(.data[]; .type == "agent.message"))'
echo

echo "=== List Sessions ==="
api "$BASE/v1/sessions" | jq .
echo

echo "=== Terminate Session (retains Workspace files) ==="
api -X DELETE "$BASE/v1/sessions/$SESSION_ID" | jq .
SESSION_ID=""
echo

echo "=== Delete Agent ==="
api -X DELETE "$BASE/v1/agents/$AGENT_ID" | jq .
AGENT_ID=""
echo

echo "✅ HTTP and mock event-stream smoke test passed."

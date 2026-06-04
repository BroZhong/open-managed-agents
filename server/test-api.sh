#!/bin/bash
# Test script for the local dev server
# Prerequisites: server running on localhost:3000, MongoDB on localhost:27017
# Start with: cd server && pnpm dev:full

BASE="http://localhost:3000"
set -e

echo "=== Health Check ==="
curl -s "$BASE/health" | jq .
echo

echo "=== Create Agent ==="
AGENT=$(curl -s -X POST "$BASE/v1/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-agent","model":"claude-sonnet-4-6","system":"You are a helpful assistant","runtime":"claude-code"}')
echo "$AGENT" | jq .
AGENT_ID=$(echo "$AGENT" | jq -r '.id')
echo "Agent ID: $AGENT_ID"
echo

echo "=== List Agents ==="
curl -s "$BASE/v1/agents" | jq .
echo

echo "=== Get Agent ==="
curl -s "$BASE/v1/agents/$AGENT_ID" | jq .
echo

echo "=== Create Session ==="
SESSION=$(curl -s -X POST "$BASE/v1/sessions" \
  -H "Content-Type: application/json" \
  -d "{\"agent\":\"$AGENT_ID\"}")
echo "$SESSION" | jq .
SESSION_ID=$(echo "$SESSION" | jq -r '.id')
echo "Session ID: $SESSION_ID"
echo

echo "=== Send Message (POST /messages) ==="
echo "(Streaming SSE response...)"
curl -s -N -X POST "$BASE/v1/sessions/$SESSION_ID/messages" \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello, agent!"}' &
CURL_PID=$!
sleep 2
kill $CURL_PID 2>/dev/null || true
echo
echo

echo "=== Send Event Directly ==="
curl -s -X POST "$BASE/v1/sessions/$SESSION_ID/events" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"user.message","data":{"content":[{"type":"text","text":"direct event"}]}}]}' | jq .
echo

echo "=== Get Events (JSON) ==="
curl -s "$BASE/v1/sessions/$SESSION_ID/events" \
  -H "Accept: application/json" | jq .
echo

echo "=== List Sessions ==="
curl -s "$BASE/v1/sessions" | jq .
echo

echo "=== Delete Session ==="
curl -s -X DELETE "$BASE/v1/sessions/$SESSION_ID" | jq .
echo

echo "=== Delete Agent ==="
curl -s -X DELETE "$BASE/v1/agents/$AGENT_ID" | jq .
echo

echo "✅ All API calls completed successfully!"

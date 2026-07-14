#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
LAUNCHER="$SCRIPT_DIR/story-seed-launcher"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/workspace"
output=$(
  OMA_SKILLS_ROOT="$REPO_ROOT/skills" \
  STORY_SEED_WORKSPACE="$TMP_DIR/workspace" \
  sh "$LAUNCHER" doctor
)
[ "$output" = "故事种子检查：通过" ]

mkdir -p "$TMP_DIR/missing"
if OMA_SKILLS_ROOT="$TMP_DIR/missing" sh "$LAUNCHER" doctor \
  >"$TMP_DIR/missing.out" 2>"$TMP_DIR/missing.err"; then
  echo "expected missing Skill scripts to fail" >&2
  exit 1
fi
grep -q "no equipped Skill provides scripts/story-seed" "$TMP_DIR/missing.err"

mkdir -p "$TMP_DIR/conflict/a/scripts" "$TMP_DIR/conflict/b/scripts"
printf '%s\n' 'console.log("a")' >"$TMP_DIR/conflict/a/scripts/story-seed"
printf '%s\n' 'console.log("b")' >"$TMP_DIR/conflict/b/scripts/story-seed"
if OMA_SKILLS_ROOT="$TMP_DIR/conflict" sh "$LAUNCHER" doctor \
  >"$TMP_DIR/conflict.out" 2>"$TMP_DIR/conflict.err"; then
  echo "expected conflicting Skill scripts to fail" >&2
  exit 1
fi
grep -q "equipped Skill scripts differ" "$TMP_DIR/conflict.err"

echo "story-seed launcher tests: ok"

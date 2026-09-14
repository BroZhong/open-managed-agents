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

# Exercise default selection without creating /home/user paths on the host.
# The shell's cd shim represents the CSI-mounted directory; Node records the
# exported root and effective cwd so the real launcher contract is observed.
mkdir -p "$TMP_DIR/bin"
cat >"$TMP_DIR/bin/node" <<'NODE'
#!/bin/sh
printf '%s\n' "$STORY_SEED_WORKSPACE" "$PWD"
NODE
chmod +x "$TMP_DIR/bin/node"
output=$(
  unset STORY_SEED_WORKSPACE
  export OMA_SKILLS_ROOT="$REPO_ROOT/skills" PATH="$TMP_DIR/bin:$PATH"
  export OMA_TEST_WORKSPACE="$TMP_DIR/workspace"
  sh -c '
    cd() {
      [ "$1" = /home/user/workspace ] || exit 1
      command cd "$OMA_TEST_WORKSPACE"
    }
    . "$1"
  ' sh "$LAUNCHER"
)
expected=$(printf '%s\n' /home/user/workspace "$TMP_DIR/workspace")
[ "$output" = "$expected" ]

# A deliberately supplied local-test root controls both files and relative
# CLI arguments. The launcher must not leave cwd at its caller directory.
output=$(
  OMA_SKILLS_ROOT="$REPO_ROOT/skills" \
  STORY_SEED_WORKSPACE="$TMP_DIR/workspace" \
  PATH="$TMP_DIR/bin:$PATH" sh "$LAUNCHER" doctor
)
expected=$(printf '%s\n' "$TMP_DIR/workspace" "$TMP_DIR/workspace")
[ "$output" = "$expected" ]

# A missing explicit root fails before running Node; it is never mkdir'd.
if OMA_SKILLS_ROOT="$REPO_ROOT/skills" \
  STORY_SEED_WORKSPACE="$TMP_DIR/unmounted" \
  PATH="$TMP_DIR/bin:$PATH" sh "$LAUNCHER" doctor \
  >"$TMP_DIR/unmounted.out" 2>"$TMP_DIR/unmounted.err"; then
  echo "expected an unavailable Workspace to fail" >&2
  exit 1
fi
[ ! -e "$TMP_DIR/unmounted" ]
[ ! -s "$TMP_DIR/unmounted.out" ]

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

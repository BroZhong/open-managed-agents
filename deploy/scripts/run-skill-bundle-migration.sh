#!/usr/bin/env bash
# Run the one-time Skill Bundle migration (#266, ADR-0022) inside an environment's API Pod.
#
#   OMA_FONT=/path/to/LiberationSans-Regular.ttf \
#     deploy/scripts/run-skill-bundle-migration.sh <test|production> <local report.json> [flags]
#
# flags: --dry-run | --since <T0> | --manifest <local report.json or journal.jsonl> (repeatable) | --concurrency <n>
#
# Bundles server/packages/api/src/migrate-skill-bundles.ts with esbuild (the deployed image
# predates it), copies it, the font and any manifests into a fresh directory of a Running, Ready
# oma-api Pod that is not terminating, and runs it with node against the Pod's PG_*, S3_* and
# WORKSPACE_OSS_* environment. On exit, also after a failure or Ctrl-C, it copies back the JSON
# report and the run's ownership journal (<report>.journal.jsonl: if the run died before writing
# its report, pass the journal as --manifest to every later run), keeps the summary beside them as
# .txt, and deletes the Pod directory unless the tool is still running there. It never overwrites a
# local report or journal. --schema/--supabase-bucket are filled in per environment and checked by
# the tool against PG_SCHEMA and S3_BUCKET. Cluster: OMA_KUBECONFIG (default
# ~/.kube/agent-platform-config), never the ambient KUBECONFIG. Every kubectl call has
# --request-timeout (OMA_KUBECTL_REQUEST_TIMEOUT, default 30s); it bounds each API request, not the
# streamed run. Production needs separate authorization (#271), OMA_ALLOW_PRODUCTION_MIGRATION=yes,
# and a working tree without uncommitted changes; the commit the tool is built from is printed.
set -euo pipefail

usage() { sed -n '2,7p' "$0" >&2; exit 64; }
[ $# -ge 2 ] || usage
env_name=$1 report=$2
shift 2
case $env_name in
  test) ns=oma-test schema=oma_test supabase_bucket=workspace-test ;;
  production)
    [ "${OMA_ALLOW_PRODUCTION_MIGRATION:-}" = yes ] || { echo "Production needs OMA_ALLOW_PRODUCTION_MIGRATION=yes (#271)" >&2; exit 1; }
    ns=oma-infra schema=oma supabase_bucket=workspace ;;
  *) usage ;;
esac
case $report in *.json) ;; *) echo "The local report path must end in .json" >&2; exit 64 ;; esac
summary=${report%.json}.txt journal=${report%.json}.journal.jsonl
for file in "$report" "$journal"; do
  # Reports and journals are the manifests of later runs.
  [ ! -e "$file" ] || { echo "$file exists already: choose another report path" >&2; exit 1; }
done
font=${OMA_FONT:?Set OMA_FONT to the official LiberationSans-Regular.ttf (see server/packages/api/src/skill-bundle-migration/fonts.ts)}
[ -f "$font" ] || { echo "No font file at $font" >&2; exit 1; }
manifests=() flags=()
while [ $# -gt 0 ]; do
  case $1 in
    --manifest)
      [ -f "${2:-}" ] || { echo "No manifest file at ${2:-}" >&2; exit 1; }
      manifests+=("$2"); shift 2 ;;
    *) flags+=("$1"); shift ;;
  esac
done
mkdir -p "$(dirname "$report")"

root=$(cd "$(dirname "$0")/../.." && pwd)
# What esbuild bundles from the repository, and this script.
tool_paths=(server/packages/api/src server/packages/store/src deploy/scripts/run-skill-bundle-migration.sh)
commit=$(git -C "$root" rev-parse HEAD)
if git -C "$root" diff --quiet HEAD -- && [ -z "$(git -C "$root" ls-files --others --exclude-standard -- "${tool_paths[@]}")" ]; then
  echo "Building migrate-skill-bundles from commit $commit" >&2
elif [ "$env_name" = production ]; then
  echo "Production runs only a committed tool: commit $commit has uncommitted changes, or untracked files under ${tool_paths[*]} (git -C $root status)" >&2
  exit 1
else
  echo "Building migrate-skill-bundles from commit $commit plus uncommitted changes" >&2
fi

# Never the ambient KUBECONFIG: it may point at another cluster.
export KUBECONFIG=${OMA_KUBECONFIG:-$HOME/.kube/agent-platform-config}
kc() { kubectl --request-timeout="${OMA_KUBECTL_REQUEST_TIMEOUT:-30s}" -n "$ns" "$@"; }
pod=$(kc get pod -l app=oma-api -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.metadata.deletionTimestamp}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' |
  awk -F'\t' '$2 == "Running" && $3 == "" && $4 == "True" { print $1; exit }')
[ -n "$pod" ] || { echo "No Running, Ready oma-api Pod that is not terminating in $ns" >&2; exit 1; }
echo "Running in $ns/$pod" >&2
dir=/tmp/oma-skill-bundle-migration-$(date +%s)-$$
build=$(mktemp -d)
created=

# Fails unless the file is absent or copied: a kubectl error must not pass for "no file".
copy_back() {
  local present
  present=$(kc exec "$pod" -- sh -c 'if [ -f "$1" ]; then echo yes; else echo no; fi' sh "$dir/$1") || present=
  case $present in
    no) return 0 ;;
    yes) if kc cp "$pod:$dir/$1" "$2" >/dev/null; then echo "Copied $1 to $2" >&2; return 0; fi ;;
  esac
  echo "WARNING: could not copy $ns/$pod:$dir/$1" >&2
  return 1
}
cleanup() {
  # No `exit` here: the script's exit status stands. Every step tolerates failure.
  set +e
  if [ -n "$created" ]; then
    running=$(kc exec "$pod" -- sh -c 'if [ -f "$1/pid" ] && kill -0 "$(cat "$1/pid")" 2>/dev/null; then echo yes; else echo no; fi' sh "$dir") ||
      running=
    if [ "$running" = no ]; then
      copied=yes
      copy_back report.json "$report" || copied=
      copy_back report.journal.jsonl "$journal" || copied=
      if [ -n "$copied" ]; then
        kc exec "$pod" -- rm -rf "$dir" >/dev/null 2>&1 || echo "WARNING: could not delete $ns/$pod:$dir" >&2
      else
        echo "WARNING: left $ns/$pod:$dir in place: copy it by hand, then delete it" >&2
      fi
    elif [ "$running" = yes ]; then
      echo "WARNING: the migration is still running in $ns/$pod; left $dir in place. When it ends, copy report.json" \
        "and report.journal.jsonl from there, then delete it" >&2
    else
      echo "WARNING: could not reach $ns/$pod; left $dir in place: copy report.json and report.journal.jsonl by hand" >&2
    fi
  fi
  rm -rf "$build"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# esbuild is no direct dependency of any workspace package, so `pnpm --dir server exec esbuild` finds
# nothing. Resolve the esbuild that @oma-server/api's devDependency tsx declares instead of reaching
# into pnpm's private hoisting directory.
esbuild=$(cd "$root/server/packages/api" && node -p 'const { dirname, join } = require("node:path");
  join(dirname(require.resolve("esbuild/package.json", { paths: [dirname(require.resolve("tsx/package.json"))] })), "bin/esbuild")')
"$esbuild" "$root/server/packages/api/src/migrate-skill-bundles.ts" \
  --bundle --platform=node --format=esm --target=node22 --external:proxy-agent --external:pg-native --log-level=warning \
  "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile="$build/migrate-skill-bundles.mjs"

kc exec "$pod" -- mkdir "$dir"
created=yes
kc cp "$build/migrate-skill-bundles.mjs" "$pod:$dir/migrate-skill-bundles.mjs" >/dev/null
kc cp "$font" "$pod:$dir/LiberationSans-Regular.ttf" >/dev/null
args=(--schema "$schema" --supabase-bucket "$supabase_bucket" --font "$dir/LiberationSans-Regular.ttf" --report "$dir/report.json")
count=0
for manifest in ${manifests[@]+"${manifests[@]}"}; do
  count=$((count + 1))
  kc cp "$manifest" "$pod:$dir/manifest-$count" >/dev/null
  args+=(--manifest "$dir/manifest-$count")
done
args+=(${flags[@]+"${flags[@]}"})

status=0
# The pid file lets the cleanup tell whether the tool outlived a broken kubectl stream.
kc exec "$pod" -- sh -c 'echo $$ > "$0/pid" && exec node "$@"' "$dir" "$dir/migrate-skill-bundles.mjs" "${args[@]}" |
  tee "$summary" || status=$?
exit "$status"

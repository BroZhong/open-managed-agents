#!/usr/bin/env bash
# Run the one-time Skill Bundle migration (#266, ADR-0022) inside an environment's API Pod.
#
#   OMA_FONT=/path/to/LiberationSans-Regular.ttf \
#     deploy/scripts/run-skill-bundle-migration.sh <test|production> <local report.json> [flags]
#
# flags: --dry-run | --since <T0> | --manifest <local report.json> (repeatable) | --concurrency <n>
#
# Bundles server/packages/api/src/migrate-skill-bundles.ts with esbuild (the deployed image
# predates it), copies it, the font and any manifests into a fresh directory of the API Pod,
# runs it with node against the Pod's PG_*, S3_* and WORKSPACE_OSS_* environment, copies the
# JSON report back to <local report.json> (summary beside it as .txt) and deletes the copies.
# --schema/--bucket are filled in per environment and checked by the tool against PG_SCHEMA
# and S3_BUCKET. Cluster: OMA_KUBECONFIG (default ~/.kube/agent-platform-config), never the ambient
# KUBECONFIG. Every kubectl call has --request-timeout (OMA_KUBECTL_REQUEST_TIMEOUT, default 30s);
# it bounds each API request, not the streamed run. Production needs separate authorization (#271):
# OMA_ALLOW_PRODUCTION_MIGRATION=yes.
set -euo pipefail

usage() { sed -n '2,8p' "$0" >&2; exit 64; }
[ $# -ge 2 ] || usage
env_name=$1 report=$2
shift 2
case $env_name in
  test) ns=oma-test schema=oma_test bucket=workspace-test ;;
  production)
    [ "${OMA_ALLOW_PRODUCTION_MIGRATION:-}" = yes ] || { echo "Production needs OMA_ALLOW_PRODUCTION_MIGRATION=yes (#271)" >&2; exit 1; }
    ns=oma-infra schema=oma bucket=workspace ;;
  *) usage ;;
esac
font=${OMA_FONT:?Set OMA_FONT to the official LiberationSans-Regular.ttf (see server/packages/api/src/skill-bundle-migration/fonts.ts)}
[ -f "$font" ] || { echo "No font file at $font" >&2; exit 1; }
# Never the ambient KUBECONFIG: it may point at another cluster.
export KUBECONFIG=${OMA_KUBECONFIG:-$HOME/.kube/agent-platform-config}
kc() { kubectl --request-timeout="${OMA_KUBECTL_REQUEST_TIMEOUT:-30s}" -n "$ns" "$@"; }
root=$(cd "$(dirname "$0")/../.." && pwd)
build=$(mktemp -d)
pod=$(kc get pod -l app=oma-api --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
[ -n "$pod" ] || { echo "No running oma-api Pod in $ns" >&2; exit 1; }
dir=/tmp/oma-skill-bundle-migration-$(date +%s)-$$
cleanup() {
  kc exec "$pod" -- rm -rf "$dir" >/dev/null 2>&1 || echo "WARNING: could not delete $ns/$pod:$dir" >&2
  rm -rf "$build"
}
trap cleanup EXIT

"$root/server/node_modules/.pnpm/node_modules/esbuild/bin/esbuild" "$root/server/packages/api/src/migrate-skill-bundles.ts" \
  --bundle --platform=node --format=esm --target=node22 --external:proxy-agent --external:pg-native --log-level=warning \
  "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile="$build/migrate-skill-bundles.mjs"

kc exec "$pod" -- mkdir -p "$dir"
kc cp "$build/migrate-skill-bundles.mjs" "$pod:$dir/migrate-skill-bundles.mjs" >/dev/null
kc cp "$font" "$pod:$dir/LiberationSans-Regular.ttf" >/dev/null
args=(--schema "$schema" --bucket "$bucket" --font "$dir/LiberationSans-Regular.ttf" --report "$dir/report.json")
manifests=0
while [ $# -gt 0 ]; do
  case $1 in
    --manifest)
      [ -f "${2:-}" ] || { echo "No manifest file at ${2:-}" >&2; exit 1; }
      manifests=$((manifests + 1))
      kc cp "$2" "$pod:$dir/manifest-$manifests.json" >/dev/null
      args+=(--manifest "$dir/manifest-$manifests.json"); shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

status=0
kc exec "$pod" -- node "$dir/migrate-skill-bundles.mjs" "${args[@]}" | tee "${report%.json}.txt" || status=$?
if kc exec "$pod" -- test -f "$dir/report.json"; then
  mkdir -p "$(dirname "$report")"
  kc cp "$pod:$dir/report.json" "$report" >/dev/null
  echo "Report copied to $report" >&2
fi
exit "$status"

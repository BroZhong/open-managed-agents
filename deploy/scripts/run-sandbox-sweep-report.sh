#!/usr/bin/env bash
# Print the read-only ADR-0023 sweep report (#289) for one environment, run inside one of its Runner Pods.
#
#   deploy/scripts/run-sandbox-sweep-report.sh <test|production> > report.md
#
# The gateway (E2B_API_URL) is reachable only inside the cluster. Bundles
# server/packages/api/src/sandbox-sweep-report.ts with esbuild (the deployed image predates it), copies
# the bundle into a fresh /tmp directory of a Running, Ready oma-runner Pod that is not terminating, checks
# its sha256 there, runs it with node against the Pod's E2B_API_URL, E2B_API_KEY and PG_*, and deletes the
# directory on exit, also after a failure or Ctrl-C. It does not stream the bundle over `kubectl exec -i`:
# on these ACS Pods, output written after stdin's EOF is lost. The tool only GETs the gateway's list and
# only SELECTs, inside a READ ONLY transaction; it checks PG_SCHEMA against the environment's schema. The
# markdown report goes to stdout once its end marker arrived, progress to stderr. Cluster: OMA_KUBECONFIG
# (default ~/.kube/agent-platform-config), never the ambient KUBECONFIG. Every kubectl call has
# --request-timeout (OMA_KUBECTL_REQUEST_TIMEOUT, default 30s).
set -euo pipefail

usage() { sed -n '2,4p' "$0" >&2; exit 64; }
[ $# -eq 1 ] || usage
env_name=$1
case $env_name in
  test) ns=oma-test schema=oma_test ;;
  production) ns=oma-infra schema=oma ;;
  *) usage ;;
esac

root=$(cd "$(dirname "$0")/../.." && pwd)
# Never the ambient KUBECONFIG: it may point at another cluster.
export KUBECONFIG=${OMA_KUBECONFIG:-$HOME/.kube/agent-platform-config}
kc() { kubectl --request-timeout="${OMA_KUBECTL_REQUEST_TIMEOUT:-30s}" -n "$ns" "$@"; }
pod=$(kc get pod -l app=oma-runner -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.metadata.deletionTimestamp}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' |
  awk -F'\t' '$2 == "Running" && $3 == "" && $4 == "True" { print $1; exit }')
[ -n "$pod" ] || { echo "No Running, Ready oma-runner Pod that is not terminating in $ns" >&2; exit 1; }

dir=/tmp/oma-sandbox-sweep-report-$(date +%s)-$$
build=$(mktemp -d)
created=
cleanup() {
  # No `exit` here: the script's exit status stands.
  set +e
  if [ -n "$created" ]; then
    kc exec "$pod" -- rm -rf "$dir" >/dev/null 2>&1 || echo "WARNING: could not delete $ns/$pod:$dir" >&2
  fi
  rm -rf "$build"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# As run-skill-bundle-migration.sh: the esbuild that @oma-server/api's devDependency tsx declares.
esbuild=$(cd "$root/server/packages/api" && node -p 'const { dirname, join } = require("node:path");
  join(dirname(require.resolve("esbuild/package.json", { paths: [dirname(require.resolve("tsx/package.json"))] })), "bin/esbuild")')
"$esbuild" "$root/server/packages/api/src/sandbox-sweep-report.ts" \
  --bundle --platform=node --format=esm --target=node22 --external:proxy-agent --external:pg-native --log-level=warning \
  "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile="$build/sandbox-sweep-report.mjs"
sum=$(shasum -a 256 "$build/sandbox-sweep-report.mjs" | cut -d' ' -f1)

echo "Reporting $env_name from $ns/$pod, built from $(git -C "$root" describe --always --dirty --abbrev=12)" >&2
kc exec "$pod" -- mkdir "$dir"
created=yes
kc cp "$build/sandbox-sweep-report.mjs" "$pod:$dir/sandbox-sweep-report.mjs" >/dev/null
[ "$(kc exec "$pod" -- sha256sum "$dir/sandbox-sweep-report.mjs" | cut -d' ' -f1)" = "$sum" ] ||
  { echo "The copy in $ns/$pod differs from the bundle" >&2; exit 1; }
kc exec "$pod" -- node "$dir/sandbox-sweep-report.mjs" --environment "$env_name" --schema "$schema" > "$build/report.md"
# A report without its last line was cut off on the way.
[ "$(tail -n 1 "$build/report.md")" = "<!-- end of report -->" ] || { echo "The report arrived incomplete" >&2; exit 1; }
cat "$build/report.md"

#!/usr/bin/env bash
# Operator side of the live ADR-0023 acceptance on oma-test (#292); runbook: deploy/README.md § Sandbox binding reconciliation on oma-test.
#
#   deploy/scripts/run-sandbox-reconcile-acceptance.sh <phase> [args...]             one phase of verify-sandbox-reconcile.mjs in the API Pod
#   deploy/scripts/run-sandbox-reconcile-acceptance.sh owner <sessionId>             the Runner Pod that holds the Session's Turn
#   deploy/scripts/run-sandbox-reconcile-acceptance.sh kill-runner <pod>             kill -9 that Runner's node process (operator action)
#   deploy/scripts/run-sandbox-reconcile-acceptance.sh sweep-logs [since] [report]   sandbox_sweep lines of every Runner Pod, summarized
#   deploy/scripts/run-sandbox-reconcile-acceptance.sh finish                        delete the run directory from the API Pod
#
# Phases: migration, init, burst, check, kill-start, mark, kill-finish, cleanup (see the .mjs header). The first phase
# makes a fresh /tmp directory in a Running, Ready oma-api Pod that is not terminating and remembers Pod and directory
# in "$OMA_RECONCILE_EVIDENCE.pod". Every phase copies the .mjs there again (checking its sha256) with the local
# evidence, runs it with `node --import tsx` and without `kubectl exec -i` (on these ACS Pods output written after
# stdin's EOF is lost), checks the end marker and copies the evidence back (mode 0600), also after a failed phase. If
# the Pod is gone, the next phase starts again in a new Pod from the local evidence. Do not interrupt a phase: the
# process in the Pod keeps running without its evidence coming back. Output is appended to the evidence's .log file.
# VERIFY_* variables of the caller pass through, except VERIFY_SCHEMA. Evidence: OMA_RECONCILE_EVIDENCE (default
# ./sandbox-reconcile-oma-test.json). Cluster: OMA_KUBECONFIG (default ~/.kube/agent-platform-config), never the ambient
# KUBECONFIG; namespace oma-test only. Quick kubectl calls have --request-timeout (OMA_KUBECTL_REQUEST_TIMEOUT, 30s).
set -euo pipefail
umask 077

usage() { sed -n '2,8p' "$0" >&2; exit 64; }
[ $# -ge 1 ] || usage

root=$(cd "$(dirname "$0")/../.." && pwd)
script="$root/deploy/scripts/verify-sandbox-reconcile.mjs"
export KUBECONFIG=${OMA_KUBECONFIG:-$HOME/.kube/agent-platform-config}
ns=oma-test
evidence=${OMA_RECONCILE_EVIDENCE:-$PWD/sandbox-reconcile-oma-test.json}
state="$evidence.pod"
log="${evidence%.json}.log"
kc() { kubectl --request-timeout="${OMA_KUBECTL_REQUEST_TIMEOUT:-30s}" -n "$ns" "$@"; }
# A phase runs for up to half an hour; its exec stream must not hit a request timeout.
kx() { kubectl --request-timeout=0 -n "$ns" "$@"; }

ready_pod() {
  kc get pod -l "app=$1" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.metadata.deletionTimestamp}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' |
    awk -F'\t' '$2 == "Running" && $3 == "" && $4 == "True" { print $1; exit }'
}
runner_pods() { kc get pod -l app=oma-runner -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'; }

run_phase() {
  local phase=$1 pod='' dir=''
  shift
  if [ -f "$state" ]; then read -r pod dir < "$state"; fi
  if [ -z "$pod" ] || ! kc exec "$pod" -c api -- test -d "$dir" 2>/dev/null; then
    pod=$(ready_pod oma-api)
    [ -n "$pod" ] || { echo "No Running, Ready oma-api Pod that is not terminating in $ns" >&2; exit 1; }
    dir=/tmp/oma-sandbox-reconcile-$(date +%s)-$$
    kc exec "$pod" -c api -- mkdir -m 700 "$dir"
    printf '%s %s\n' "$pod" "$dir" > "$state"
    echo "Run directory $ns/$pod:$dir" >&2
  fi
  local sum
  sum=$(shasum -a 256 "$script" | cut -d' ' -f1)
  kc cp -c api "$script" "$pod:$dir/verify-sandbox-reconcile.mjs" >/dev/null
  [ "$(kc exec "$pod" -c api -- sha256sum "$dir/verify-sandbox-reconcile.mjs" | cut -d' ' -f1)" = "$sum" ] ||
    { echo "The copy in $ns/$pod differs from $script" >&2; exit 1; }
  if [ -f "$evidence" ]; then kc cp -c api "$evidence" "$pod:$dir/evidence.json" >/dev/null; fi
  local pass=() name
  while IFS= read -r name; do pass+=("$name=${!name}"); done < <(compgen -e | grep '^VERIFY_' | grep -vx VERIFY_SCHEMA || true)
  local out status=0
  out=$(mktemp)
  echo "=== $(date -u +%FT%TZ) $phase $*" >> "$log"
  set +e
  # The container's working directory, /app/server/packages/api, resolves tsx.
  kx exec "$pod" -c api -- env HTTP_PROXY= http_proxy= HTTPS_PROXY= https_proxy= ${pass[@]+"${pass[@]}"} \
    VERIFY_SCHEMA=oma_test OMA_LIVE_BASE_URL=https://agentry-test.welltop.tech/api \
    node --import tsx "$dir/verify-sandbox-reconcile.mjs" "$phase" "$dir/evidence.json" "$@" | tee "$out" | tee -a "$log"
  status=${PIPESTATUS[0]}
  set -e
  if kc exec "$pod" -c api -- test -f "$dir/evidence.json"; then
    kc cp -c api "$pod:$dir/evidence.json" "$evidence.tmp" >/dev/null && chmod 600 "$evidence.tmp" && mv "$evidence.tmp" "$evidence"
  else
    echo "WARNING: no evidence in $ns/$pod:$dir" >&2
  fi
  local last
  last=$(tail -n 1 "$out")
  rm -f "$out"
  case $last in
    "END verify-sandbox-reconcile phase=$phase "*) ;;
    *) echo "The output of $phase arrived incomplete" >&2; exit 1 ;;
  esac
  return "$status"
}

# claim_owner is host_<uuid>, not a Pod name. Every journal write round logs
# {"msg":"turn_journal_flush","sessionId":...}, the input promotion included: the Pod with the newest such
# line for the Session holds its Turn.
owner() {
  local id=$1 best='' best_ts='' pod line ts since=${OMA_OWNER_SINCE:-15m}
  for pod in $(runner_pods); do
    line=$(kc logs "$pod" -c runner --since="$since" --timestamps 2>/dev/null | grep -F "\"sessionId\":\"$id\"" | tail -n 1 || true)
    [ -n "$line" ] || continue
    ts=${line%% *}
    echo "OWNER_CANDIDATE pod=$pod last=$ts"
    if [ -z "$best_ts" ] || [[ "$ts" > "$best_ts" ]]; then best=$pod best_ts=$ts; fi
  done
  [ -n "$best" ] || { echo "No Runner Pod logged Session $id in the last $since" >&2; exit 1; }
  echo "OWNER_POD=$best"
}

# The test overlay sets shareProcessNamespace, so node is not PID 1 and SIGKILL from a sibling process takes
# effect, as an OOM kill or a node failure would. Killing the container's main process also ends this exec.
kill_runner() {
  local pod=$1 out killed
  case $pod in oma-runner-*) ;; *) echo "kill-runner takes an oma-runner Pod name" >&2; exit 64 ;; esac
  out=$(kc exec "$pod" -c runner -- sh -c '
    for p in /proc/[0-9]*; do
      pid=${p#/proc/}
      set -f; set -- $(tr "\0" " " < "$p/cmdline" 2>/dev/null); set +f
      [ "${1##*/}" = node ] || continue
      case " $* " in *" src/runner-server.ts "*) ;; *) continue ;; esac
      echo "KILLED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) pid=$pid"
      kill -9 "$pid"
      exit 0
    done
    echo "no node src/runner-server.ts process" >&2
    exit 1' 2>&1) || true
  printf '%s\n' "$out"
  killed=$(printf '%s\n' "$out" | sed -n 's/^KILLED_AT=\([^ ]*\).*/\1/p')
  [ -n "$killed" ] || { echo "Nothing was killed in $ns/$pod" >&2; exit 1; }
  echo "NEXT $0 mark kill $killed   (and restore the test SandboxSet's spec.replicas if you emptied it)"
}

sweep_logs() {
  local since=${1:-90m} report=${2:-} pod lines status=0
  lines=$(mktemp)
  for pod in $(runner_pods); do
    { kc logs "$pod" -c runner --since="$since" --timestamps 2>/dev/null || true; } | { grep -F sandbox_sweep || true; } | sed "s|^|$pod |" >> "$lines"
    { kc logs "$pod" -c runner --previous --since="$since" --timestamps 2>/dev/null || true; } | { grep -F sandbox_sweep || true; } | sed "s|^|$pod(previous) |" >> "$lines"
  done
  node "$script" sweep-summary ${report:+"$report"} < "$lines" || status=$?
  rm -f "$lines"
  return "$status"
}

finish() {
  local pod dir
  [ -f "$state" ] || { echo "No run directory recorded in $state" >&2; exit 1; }
  read -r pod dir < "$state"
  case $dir in /tmp/oma-sandbox-reconcile-*) ;; *) echo "Unexpected run directory $dir" >&2; exit 1 ;; esac
  kc exec "$pod" -c api -- rm -rf "$dir"
  rm -f "$state"
  echo "Deleted $ns/$pod:$dir; the evidence stays in $evidence"
}

case $1 in
  owner) [ $# -eq 2 ] || usage; owner "$2" ;;
  kill-runner) [ $# -eq 2 ] || usage; kill_runner "$2" ;;
  sweep-logs) shift; sweep_logs "$@" ;;
  finish) finish ;;
  migration|init|burst|check|kill-start|mark|kill-finish|cleanup) run_phase "$@" ;;
  *) usage ;;
esac

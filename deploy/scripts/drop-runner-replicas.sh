#!/usr/bin/env bash
# Once per namespace, before the first `kubectl apply` of a manifest whose
# oma-runner Deployment declares no replicas: drop spec.replicas from the
# Deployment's last-applied configuration. Otherwise that apply removes the
# field and the count drops to the default of 1 until KEDA raises it again.
# Changes no Pod count. Kubernetes documents this step for adopting an HPA
# under client-side apply ("Migrating Deployments and StatefulSets to
# horizontal autoscaling"). Extra arguments go to kubectl, e.g.
# --dry-run=server.
set -euo pipefail
usage='Usage: drop-runner-replicas.sh oma-test|oma-infra [kubectl args]'
namespace=${1:-}
[[ $namespace == oma-test || $namespace == oma-infra ]] || { echo "$usage" >&2; exit 2; }
shift
last=$(kubectl -n "$namespace" get deploy oma-runner \
  -o jsonpath='{.metadata.annotations.kubectl\.kubernetes\.io/last-applied-configuration}')
if [[ -z $last ]] || ! jq -e '.spec | has("replicas")' <<<"$last" >/dev/null; then
  echo "oma-runner in $namespace: the last-applied configuration declares no replicas; nothing to do"
  exit 0
fi
jq 'del(.spec.replicas)' <<<"$last" | kubectl -n "$namespace" apply set-last-applied -f - "$@"

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

KUBECONFIG_PATH="${KUBECONFIG_PATH:-${HOME}/.kube/agent-platform-config}"
KUBE_CONTEXT="${KUBE_CONTEXT:-agent-platform}"
NAMESPACE="sandbox-system"
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-300}"

pool="stock"
image=""
apply=false
confirm_production=false

usage() {
  cat <<'EOF'
Usage: deploy/scripts/deploy-sandbox.sh [options]

Validate or deploy an agent-platform SandboxSet. The default is the production
stock code-interpreter pool in server-side dry-run mode.

Options:
  --pool stock|custom       SandboxSet to process (default: stock).
  --image IMAGE             Required for the custom pool.
  --apply                   Apply and wait for an available warm-pool replica.
  --confirm-production      Required together with --apply.
  -h, --help                Show this help.

Deploying the custom pool does not change oma-server's SANDBOX_TEMPLATE.
EOF
}

while (($# > 0)); do
  case "$1" in
    --pool|--image)
      (($# >= 2)) || { echo "$1 requires a value" >&2; exit 2; }
      case "$1" in
        --pool) pool="$2" ;;
        --image) image="$2" ;;
      esac
      shift
      ;;
    --apply) apply=true ;;
    --confirm-production) confirm_production=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "${pool}" != stock && "${pool}" != custom ]]; then
  echo "--pool must be stock or custom." >&2
  exit 2
fi
if [[ "${pool}" == custom && -z "${image}" ]]; then
  echo "--image is required for --pool custom." >&2
  exit 2
fi
if [[ -n "${image}" && ! "${image}" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]]; then
  echo "Invalid image reference." >&2
  exit 2
fi
if [[ "${apply}" == true && "${confirm_production}" == false ]]; then
  echo "Production apply requires --confirm-production." >&2
  exit 2
fi

kubectl_agent_platform() {
  env -u http_proxy -u https_proxy -u all_proxy \
      -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      KUBECONFIG="${KUBECONFIG_PATH}" \
      kubectl --context "${KUBE_CONTEXT}" "$@"
}

actual_context="$(kubectl_agent_platform config current-context)"
if [[ "${actual_context}" != "${KUBE_CONTEXT}" ]]; then
  echo "Refusing to continue: kubeconfig context is ${actual_context}, expected ${KUBE_CONTEXT}." >&2
  exit 1
fi

render_dir="$(mktemp -d "${TMPDIR:-/tmp}/oma-sandbox-deploy.XXXXXX")"
trap 'rm -rf "${render_dir}"' EXIT

if [[ "${pool}" == stock ]]; then
  manifest="${REPO_ROOT}/deploy/sandbox/sandboxset-code-interpreter.yaml"
  resource_name="code-interpreter"
else
  manifest="${render_dir}/sandboxset-code-interpreter-vfscli.yaml"
  resource_name="code-interpreter-vfscli"
  sed -e "s#CUSTOM_SANDBOX_IMAGE#${image}#g" \
    "${REPO_ROOT}/deploy/sandbox/sandboxset-code-interpreter-vfscli.yaml" >"${manifest}"
fi

echo "Target: ${KUBE_CONTEXT}/${NAMESPACE} (production)"
echo "Pool:   ${resource_name}"
[[ -z "${image}" ]] || echo "Image:  ${image}"

if [[ "${apply}" == false ]]; then
  echo "Mode:   server-side dry-run"
  kubectl_agent_platform apply --dry-run=server -f "${manifest}" -o name
  exit 0
fi

echo "Mode:   apply"
kubectl_agent_platform apply -f "${manifest}"

deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
while ((SECONDS < deadline)); do
  available="$(kubectl_agent_platform -n "${NAMESPACE}" get sandboxset "${resource_name}" -o jsonpath='{.status.availableReplicas}')"
  if [[ "${available:-0}" =~ ^[0-9]+$ ]] && ((available >= 1)); then
    kubectl_agent_platform -n "${NAMESPACE}" get sandboxset "${resource_name}" \
      -o custom-columns='NAME:.metadata.name,AVAILABLE:.status.availableReplicas,IMAGE:.spec.template.spec.containers[0].image'
    exit 0
  fi
  sleep 5
done

echo "Timed out waiting for ${resource_name} to have an available replica." >&2
exit 1

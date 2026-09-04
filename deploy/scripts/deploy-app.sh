#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

REGISTRY="${REGISTRY:-registry-vpc.cn-shanghai.aliyuncs.com/welltop}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-${HOME}/.kube/agent-platform-config}"
KUBE_CONTEXT="${KUBE_CONTEXT:-agent-platform}"
NAMESPACE="oma-infra"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-5m}"

tag=""
server_image=""
web_image=""
apply=false
confirm_production=false

usage() {
  cat <<'EOF'
Usage: deploy/scripts/deploy-app.sh [options]

Render deploy/k8s.yaml with immutable images and validate it against
agent-platform. The default is a server-side dry-run.

Options:
  --tag TAG                 Use REGISTRY/oma-{server,web}:TAG.
  --server-image IMAGE      Override the complete Server image reference.
  --web-image IMAGE         Override the complete Web image reference.
  --apply                   Apply and wait for both production rollouts.
  --confirm-production      Required together with --apply.
  -h, --help                Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --tag|--server-image|--web-image)
      (($# >= 2)) || { echo "$1 requires a value" >&2; exit 2; }
      case "$1" in
        --tag) tag="$2" ;;
        --server-image) server_image="$2" ;;
        --web-image) web_image="$2" ;;
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

if [[ -n "${tag}" ]]; then
  [[ -n "${server_image}" ]] || server_image="${REGISTRY}/oma-server:${tag}"
  [[ -n "${web_image}" ]] || web_image="${REGISTRY}/oma-web:${tag}"
fi

if [[ -z "${server_image}" || -z "${web_image}" ]]; then
  echo "Provide --tag, or provide both --server-image and --web-image." >&2
  exit 2
fi

image_pattern='^[A-Za-z0-9][A-Za-z0-9._/:@-]*$'
if [[ ! "${server_image}" =~ ${image_pattern} || ! "${web_image}" =~ ${image_pattern} ]]; then
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

render_dir="$(mktemp -d "${TMPDIR:-/tmp}/oma-deploy.XXXXXX")"
trap 'rm -rf "${render_dir}"' EXIT
rendered_manifest="${render_dir}/k8s.yaml"

sed \
  -e "s#OMA_SERVER_IMAGE#${server_image}#g" \
  -e "s#OMA_WEB_IMAGE#${web_image}#g" \
  "${REPO_ROOT}/deploy/k8s.yaml" >"${rendered_manifest}"

if grep -qE 'OMA_(SERVER|WEB)_IMAGE' "${rendered_manifest}"; then
  echo "Image placeholders remain in rendered manifest." >&2
  exit 1
fi

echo "Target:  ${KUBE_CONTEXT}/${NAMESPACE} (production)"
echo "Server:  ${server_image}"
echo "Web:     ${web_image}"

if [[ "${apply}" == false ]]; then
  echo "Mode:    server-side dry-run"
  kubectl_agent_platform apply --dry-run=server -f "${rendered_manifest}" -o name
  exit 0
fi

echo "Mode:    apply"
kubectl_agent_platform apply -f "${rendered_manifest}"
kubectl_agent_platform -n "${NAMESPACE}" rollout status deploy/oma-server --timeout="${ROLLOUT_TIMEOUT}"
kubectl_agent_platform -n "${NAMESPACE}" rollout status deploy/oma-web --timeout="${ROLLOUT_TIMEOUT}"
kubectl_agent_platform -n "${NAMESPACE}" get deploy oma-server oma-web \
  -o custom-columns='NAME:.metadata.name,READY:.status.readyReplicas,IMAGE:.spec.template.spec.containers[0].image'

env -u http_proxy -u https_proxy -u all_proxy \
    -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    curl --fail --silent --show-error --max-time 15 \
    https://agentry.welltop.tech/api/health
printf '\n'

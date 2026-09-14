#!/usr/bin/env bash
set -euo pipefail
image="${1:?Usage: verify-image.sh IMAGE}"
docker run --rm --platform linux/amd64 --network none \
  --user user --workdir /home/user --entrypoint /usr/bin/env \
  "$image" -i HOME=/home/user PATH=/usr/local/bin:/usr/bin:/bin \
  AUTO_STORY_SMOKE_VALUE=injected auto-story-smoke --require-env AUTO_STORY_SMOKE_VALUE

# Start the inherited ACS entrypoint too: the isolated SDK Python must not
# prevent the retained Jupyter environment from serving its health endpoint.
container_id="$(docker run --detach --rm --platform linux/amd64 --network none "$image")"
trap 'docker rm --force "$container_id" >/dev/null 2>&1 || true' EXIT
ready=0
for attempt in {1..30}; do
  if docker exec "$container_id" curl --fail --silent --max-time 2 \
      http://127.0.0.1:8888/api/status >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  docker logs --tail 30 "$container_id" >&2
  echo 'Inherited ACS Jupyter startup failed' >&2
  exit 1
fi
echo 'Inherited ACS Jupyter startup: healthy' >&2

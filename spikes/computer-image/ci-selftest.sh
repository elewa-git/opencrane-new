#!/usr/bin/env bash
# Runs inside Cloud Build. Starts the freshly built image in a plain container (not gVisor) and runs the
# self-test. This is an early warning that saves cluster hours; the real test is the Pod on the gVisor pool.
set -uo pipefail
IMAGE="$1"

docker image inspect "${IMAGE}" --format 'image size: {{.Size}} bytes'
trap 'docker rm -f ocn-spike-computer >/dev/null 2>&1 || true' EXIT
docker run -d --mount type=volume,destination=/home/agent --name ocn-spike-computer "${IMAGE}" > /dev/null

for i in $(seq 1 60); do
  if docker exec ocn-spike-computer node -e "fetch('http://127.0.0.1:8080/health',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "health endpoint answered 200 after about $((i * 2)) seconds"
    break
  fi
  if (( i % 5 == 0 )); then docker logs ocn-spike-computer 2>&1 | tail -15; fi
  sleep 2
done

timeout 120 docker exec ocn-spike-computer node /opt/computer/selftest.mjs
rc=$?

echo "=== container logs (last 120 lines)"
docker logs ocn-spike-computer 2>&1 | tail -120
echo "=== npm components and licences"
docker exec ocn-spike-computer cat /opt/computer/licences/components.txt
echo "=== pip freeze"
docker exec ocn-spike-computer cat /opt/computer/licences/pip-freeze.txt
docker rm -f ocn-spike-computer > /dev/null
echo "self-test exit code: ${rc}"
exit "${rc}"

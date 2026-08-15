#!/usr/bin/env bash
# bfstats-backup-neo4j — stop neo4j deployment, tar the store to stdout (gzipped), restart
#
# Scales the neo4j deployment to 0, waits for the pod to terminate (ensuring
# Neo4j flushes and closes its store files), then tars the Neo4j data directory
# from the local-path PVC host path and pipes it gzipped to stdout.
# A trap restarts the deployment on exit regardless of outcome.
#
# Neo4j 5 Community Edition stores its data at:
#   <pvc-host-path>/databases/neo4j/   (store files)
#   <pvc-host-path>/transactions/neo4j/ (tx logs)
# Both are included in the archive for a complete restorable backup.
#
# Output is a gzipped tar archive — stream directly to the browser.
# Download filename suggestion: bfstats-neo4j-YYYY-MM-DD.tar.gz
#
# params:
#   NAMESPACE:  { label: "k3s namespace for Neo4j", default: "bf42-stats" }
#   NEO4J_PVC_PATH: { label: "Host path to Neo4j PVC (blank = auto-locate)", default: "" }
# nodes: [ hetzner/bfstats ]
# confirm: This will stop the neo4j deployment, archive the Neo4j data directory, then restart it. The app will be unavailable for ~30–90s. Continue?

set -euo pipefail

command -v kubectl >/dev/null 2>&1 || { echo "kubectl not installed on host" >&2; exit 2; }
command -v tar     >/dev/null 2>&1 || { echo "tar not installed on host" >&2; exit 2; }

NS="${NAMESPACE:-bf42-stats}"
NEO4J_DEP="neo4j"
APP_DEP="bf42-stats"

# Restart BOTH deployments on exit so neither is left scaled to 0 on failure.
trap 'echo "Restarting deployments..." >&2
      kubectl scale deployment/"${APP_DEP}"   -n "${NS}" --replicas=1 >&2 || true
      kubectl scale deployment/"${NEO4J_DEP}" -n "${NS}" --replicas=1 >&2 || true' EXIT

# Stop the app first (it holds Neo4j connections) then Neo4j itself.
echo "Scaling down ${NS}/${APP_DEP}..." >&2
kubectl scale deployment/"${APP_DEP}" -n "${NS}" --replicas=0 >&2

echo "Waiting for ${APP_DEP} pod to terminate..." >&2
kubectl wait --for=delete pod -l app="${APP_DEP}" -n "${NS}" --timeout=90s >&2 2>/dev/null || true

echo "Scaling down ${NS}/${NEO4J_DEP}..." >&2
kubectl scale deployment/"${NEO4J_DEP}" -n "${NS}" --replicas=0 >&2

echo "Waiting for neo4j pod to terminate..." >&2
kubectl wait --for=delete pod -l app="${NEO4J_DEP}" -n "${NS}" --timeout=90s >&2 2>/dev/null || true
sleep 3

# Locate the PVC host path
pvc_path="${NEO4J_PVC_PATH:-}"
if [ -z "$pvc_path" ]; then
  pvc_path="/var/lib/rancher/k3s/storage/pvc-2990ca0b-7a1d-4315-b912-256e470a13ca_bf42-stats_neo4j-pvc"
fi
[ -d "$pvc_path" ] || { echo "Neo4j PVC path not found: $pvc_path" >&2; exit 1; }

echo "Archiving ${pvc_path} ..." >&2
# Stream the tar directly to stdout — no temp file on the host.
# The trap will restart both deployments after this completes (or fails).
tar -czf - -C "$pvc_path" .

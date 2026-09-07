#!/usr/bin/env bash
# bfstats-backup-neo4j — disable background jobs, shut down neo4j cleanly, tar the store (gzipped)
#
# Disables DISABLE_BACKGROUND_PROCESSING to pause all database writes while keeping the API
# running for read traffic. Scales the Neo4j deployment to 0 (ensuring it flushes and closes
# store files cleanly), then tars the Neo4j data directory from the local-path PVC host path
# and saves it as a gzipped backup. Logs progress with timestamps. Re-enables background jobs
# and restarts Neo4j on completion (success or failure).
#
# Neo4j 5 Community Edition stores its data at:
#   <pvc-host-path>/databases/neo4j/   (store files)
#   <pvc-host-path>/transactions/neo4j/ (tx logs)
# Both are included in the archive for a complete restorable backup.
#
# Output path and scp command for manual download.
#
# params:
#   NAMESPACE:  { label: "k3s namespace for Neo4j", default: "bf42-stats" }
#   NEO4J_PVC_PATH: { label: "Host path to Neo4j PVC (blank = auto-locate)", default: "" }
# nodes: [ hetzner/bfstats ]
# confirm: This will pause background jobs and shut down Neo4j cleanly for backup (~5-15 min). API reads stay online. Continue?

set -euo pipefail

command -v kubectl >/dev/null 2>&1 || { echo "kubectl not installed on host" >&2; exit 2; }
command -v tar     >/dev/null 2>&1 || { echo "tar not installed on host" >&2; exit 2; }

NS="${NAMESPACE:-bf42-stats}"
NEO4J_DEP="neo4j"
APP_DEP="bf42-stats"

log() { echo "[$(date +'%H:%M:%S')] $*" >&2; }

# Restart deployments and re-enable background processing on exit
trap 'log "Re-enabling background processing and restarting deployments..."
      kubectl set env deployment/"${APP_DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=false --record >&2 || true
      kubectl scale deployment/"${NEO4J_DEP}" -n "${NS}" --replicas=1 >&2 || true
      kubectl rollout status deployment/"${APP_DEP}" -n "${NS}" --timeout=120s >&2 || true' EXIT

# ── Phase 1: disable background processing ───────────────────────────────────
log "Disabling background processing (API reads stay online)..."
kubectl set env deployment/"${APP_DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=true --record >&2

log "Waiting for rollout to complete (pods restarting)..."
kubectl rollout status deployment/"${APP_DEP}" -n "${NS}" --timeout=120s >&2

# ── Phase 2: shut down Neo4j cleanly ──────────────────────────────────────────
log "Scaling down ${NEO4J_DEP} (flushing and closing store files)..."
kubectl scale deployment/"${NEO4J_DEP}" -n "${NS}" --replicas=0 >&2

log "Waiting for neo4j pod to terminate..."
kubectl wait --for=delete pod -l "app=${NEO4J_DEP}" -n "${NS}" --timeout=120s >&2 2>/dev/null || true
sleep 2

# Locate the PVC host path
pvc_path="${NEO4J_PVC_PATH:-}"
if [ -z "$pvc_path" ]; then
  pvc_path="/var/lib/rancher/k3s/storage/pvc-2990ca0b-7a1d-4315-b912-256e470a13ca_bf42-stats_neo4j-pvc"
fi
[ -d "$pvc_path" ] || { log "ERROR: Neo4j PVC path not found: $pvc_path"; exit 1; }

pvc_size=$(du -sh "$pvc_path" | cut -f1)
log "Neo4j data directory located (size: ${pvc_size})"

# ── Phase 3: archive to backup file ──────────────────────────────────────────
backup_file="/tmp/bfstats-neo4j-$(date +%Y%m%d-%H%M%S).tar.gz"
log "Compressing and archiving ${pvc_path} to ${backup_file}..."

start=$(date +%s)
tar -czf "$backup_file" -C "$pvc_path" .
end=$(date +%s)
elapsed=$((end - start))

compressed_size=$(du -sh "$backup_file" | cut -f1)
log "Archive complete (${elapsed}s, compressed: ${compressed_size})"

echo "" >&2
log "✓ Backup complete"
log "Path: $backup_file"
log "Size: ${pvc_size} → ${compressed_size}"
echo "" >&2
echo "Download with:" >&2
echo "  scp hetzner:$backup_file ./" >&2
echo "" >&2

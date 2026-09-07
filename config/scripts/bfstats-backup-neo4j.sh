#!/usr/bin/env bash
# bfstats-backup-neo4j — disable background jobs, shut down neo4j, compress, upload to Azure
#
# Disables DISABLE_BACKGROUND_PROCESSING to pause all database writes while keeping the API
# running for read traffic. Scales the Neo4j deployment to 0 (ensuring it flushes and closes
# store files cleanly), tars the Neo4j data directory from the local-path PVC host path,
# compresses with zstd (parallel), and uploads to Azure. Logs progress with timestamps.
# Re-enables background jobs and restarts Neo4j on completion (success or failure).
#
# Neo4j 5 Community Edition stores its data at:
#   <pvc-host-path>/databases/neo4j/   (store files)
#   <pvc-host-path>/transactions/neo4j/ (tx logs)
# Both are included in the archive for a complete restorable backup.
#
# params:
#   NAMESPACE:  { label: "k3s namespace for Neo4j", default: "bf42-stats" }
#   NEO4J_PVC_PATH: { label: "Host path to Neo4j PVC (blank = auto-locate)", default: "" }
#   BACKUP_DIR: { label: "Host backup directory", default: "/backup" }
#   AZURE_SAS_URL: { label: "Azure Blob SAS URL (e.g., https://account.blob.core.windows.net/container?sv=...)", required: true }
# nodes: [ hetzner/bfstats ]
# confirm: This will pause background jobs and shut down Neo4j cleanly for backup (~15-20 min total). API reads stay online. Continue?

set -euo pipefail

command -v kubectl >/dev/null 2>&1 || { echo "kubectl not installed on host" >&2; exit 2; }
command -v tar     >/dev/null 2>&1 || { echo "tar not installed on host" >&2; exit 2; }
command -v zstd    >/dev/null 2>&1 || { echo "Installing zstd..." >&2; apt-get update && apt-get install -y zstd >&2; }
command -v azcopy  >/dev/null 2>&1 || { echo "Installing azcopy..." >&2; curl -sL https://aka.ms/downloadazcopy-v10-linux-arm64 -o /tmp/azcopy.tar.gz && tar -xzf /tmp/azcopy.tar.gz -C /tmp && sudo mv /tmp/azcopy_linux_arm64_*/azcopy /usr/local/bin/ && chmod +x /usr/local/bin/azcopy >&2; }
[ -z "${AZURE_SAS_URL:-}" ] && { echo "AZURE_SAS_URL parameter is required" >&2; exit 1; }

NS="${NAMESPACE:-bf42-stats}"
NEO4J_DEP="neo4j"
APP_DEP="bf42-stats"
BACKUP_DIR="${BACKUP_DIR:-/backup}"

log() { echo "[$(date +'%H:%M:%S')] $*" >&2; }

# Restart deployments and re-enable background processing on exit
trap 'log "Re-enabling background processing and restarting deployments..."
      kubectl set env deployment/"${APP_DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=false >&2 || true
      kubectl scale deployment/"${NEO4J_DEP}" -n "${NS}" --replicas=1 >&2 || true
      kubectl rollout status deployment/"${APP_DEP}" -n "${NS}" --timeout=120s >&2 || true' EXIT

# Create backup directory if needed
mkdir -p "$BACKUP_DIR"

# ── Phase 1: disable background processing ───────────────────────────────────
log "Disabling background processing (API reads stay online)..."
kubectl set env deployment/"${APP_DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=true >&2

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
  # Query kubectl to find the Neo4j PVC name dynamically
  pvc_name=$(kubectl get deployment "$NEO4J_DEP" -n "$NS" -o jsonpath='{.spec.template.spec.volumes[?(@.persistentVolumeClaim)].persistentVolumeClaim.claimName}' 2>/dev/null)
  if [ -z "$pvc_name" ]; then
    log "ERROR: Could not find Neo4j PVC name from deployment"
    exit 1
  fi

  # Search /var/lib/rancher/k3s/storage for the mounted PVC
  pvc_path=$(find /var/lib/rancher/k3s/storage -maxdepth 1 -type d -name "*${pvc_name}" 2>/dev/null | head -1)
  if [ -z "$pvc_path" ]; then
    log "ERROR: Could not find mounted PVC at /var/lib/rancher/k3s/storage for ${pvc_name}"
    log "Hint: Set NEO4J_PVC_PATH parameter with the correct host path"
    exit 1
  fi
  log "Located PVC ${pvc_name} at ${pvc_path}"
fi
[ -d "$pvc_path" ] || { log "ERROR: Neo4j PVC path not found: $pvc_path"; exit 1; }

pvc_size=$(du -sh "$pvc_path" | cut -f1)
log "Neo4j data directory located (size: ${pvc_size})"

# ── Phase 3: archive to backup file (uncompressed for speed) ──────────────────
backup_file="${BACKUP_DIR}/bfstats-neo4j-latest.tar"
log "Archiving ${pvc_path} to ${backup_file}..."

start=$(date +%s)
tar -cf "$backup_file" -C "$pvc_path" .
end=$(date +%s)
elapsed=$((end - start))

backup_size=$(du -sh "$backup_file" | cut -f1)
log "Archive complete (${elapsed}s, size: ${backup_size})"

# ── Phase 4: compress with zstd ──────────────────────────────────────────────
log "Compressing with zstd (using all available cores)..."
start=$(date +%s)
zstd -T0 "$backup_file" -o "$backup_file.zst"
end=$(date +%s)
elapsed=$((end - start))

backup_file_zst="${backup_file}.zst"
compressed_size=$(du -sh "$backup_file_zst" | cut -f1)
compression_ratio=$(echo "scale=1; $(stat -c%s "$backup_file") * 100 / $(stat -c%s "$backup_file_zst")" | bc)
log "Compression complete (${elapsed}s, ${backup_size} → ${compressed_size}, ${compression_ratio}%)"

# ── Phase 5: upload to Azure ─────────────────────────────────────────────────
log "Uploading to Azure..."
start=$(date +%s)
azcopy copy "$backup_file_zst" "${AZURE_SAS_URL}/" --quiet
end=$(date +%s)
elapsed=$((end - start))

log "Upload complete (${elapsed}s)"

# ── Phase 6: cleanup ─────────────────────────────────────────────────────────
log "Cleaning up uncompressed backup..."
rm -f "$backup_file"

echo "" >&2
log "✓ Backup complete and uploaded to Azure"
log "File: $(basename "$backup_file_zst")"
log "Size: ${compressed_size}"
echo "" >&2

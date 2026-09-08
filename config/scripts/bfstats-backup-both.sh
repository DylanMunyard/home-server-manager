#!/usr/bin/env bash
# bfstats-backup-both — backup Neo4j and SQLite, scale down, compress, upload to Azure
#
# Disables DISABLE_BACKGROUND_PROCESSING to pause all database writes while keeping the API
# running for read traffic. Scales the Neo4j deployment to 0 (ensuring it flushes and closes
# store files cleanly), archives the Neo4j PVC and checkpoints/copies the SQLite DB, compresses
# both with zstd (parallel), and uploads to Azure. Logs progress with timestamps.
# Re-enables background jobs and restarts Neo4j on completion (success or failure).
#
# Neo4j 5 Community Edition stores its data at:
#   <pvc-host-path>/databases/neo4j/   (store files)
#   <pvc-host-path>/transactions/neo4j/ (tx logs)
# Both are included in the archive for a complete restorable backup.
#
# SQLite database is checkpointed with TRUNCATE mode to ensure a consistent snapshot
# without any open connections.
#
# params:
#   NAMESPACE:  { label: "k3s namespace for apps", default: "bf42-stats" }
#   NEO4J_PVC_PATH: { label: "Host path to Neo4j PVC (blank = auto-locate)", default: "" }
#   DB_PATH:    { label: "Path to sqlite db (blank = auto-locate on k3s PVC)", default: "" }
#   BACKUP_DIR: { label: "Host backup directory", default: "/backup" }
#   AZURE_SAS_URL: { label: "Azure Blob SAS URL (e.g., https://account.blob.core.windows.net/container?sv=...)", required: true }
# nodes: [ hetzner/bfstats ]
# confirm: This will pause background jobs and shut down Neo4j cleanly, backing up both Neo4j and SQLite to Azure (~15-20 min total). API reads stay online. Continue?

set -euo pipefail

command -v kubectl >/dev/null 2>&1 || { echo "kubectl not installed on host" >&2; exit 2; }
command -v tar     >/dev/null 2>&1 || { echo "tar not installed on host" >&2; exit 2; }
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 not installed on host" >&2; exit 2; }
command -v zstd    >/dev/null 2>&1 || { echo "Installing zstd..." >&2; apt-get update && apt-get install -y zstd >&2; }
command -v bc      >/dev/null 2>&1 || { echo "Installing bc..." >&2; apt-get install -y bc >&2; }
command -v azcopy  >/dev/null 2>&1 || { echo "Installing azcopy..." >&2; curl -sL https://aka.ms/downloadazcopy-v10-linux-arm64 -o /tmp/azcopy.tar.gz && tar -xzf /tmp/azcopy.tar.gz -C /tmp && sudo mv /tmp/azcopy_linux_arm64_*/azcopy /usr/local/bin/ && chmod +x /usr/local/bin/azcopy >&2; }
[ -z "${AZURE_SAS_URL:-}" ] && { echo "AZURE_SAS_URL parameter is required" >&2; exit 1; }

NS="${NAMESPACE:-bf42-stats}"
NEO4J_DEP="neo4j"
APP_DEP="bf42-stats"
BACKUP_DIR="${BACKUP_DIR:-/backup}"

log() { echo "[$(date +'%H:%M:%S')] $*" >&2; }

locate_pvc() {
  local dep="$1"
  local pvc_path="${2:-}"

  if [ -n "$pvc_path" ]; then
    [ -d "$pvc_path" ] || { log "ERROR: PVC path not found: $pvc_path"; exit 1; }
    echo "$pvc_path"
    return
  fi

  local pvc_name=$(kubectl get deployment "$dep" -n "$NS" -o jsonpath='{.spec.template.spec.volumes[?(@.persistentVolumeClaim)].persistentVolumeClaim.claimName}' 2>/dev/null)
  if [ -z "$pvc_name" ]; then
    log "ERROR: Could not find $dep PVC name from deployment"
    exit 1
  fi

  pvc_path=$(find /var/lib/rancher/k3s/storage /mnt -maxdepth 5 -type d -name "*${pvc_name}" 2>/dev/null | head -1)
  if [ -z "$pvc_path" ]; then
    log "ERROR: Could not find mounted PVC at /var/lib/rancher/k3s/storage for ${pvc_name}"
    log "Hint: Set NEO4J_PVC_PATH parameter with the correct host path"
    exit 1
  fi

  log "Located PVC ${pvc_name} at ${pvc_path}"
  echo "$pvc_path"
}

locate_db() {
  local db="${1:-}"

  if [ -n "$db" ]; then
    [ -f "$db" ] || { log "ERROR: SQLite DB not found: $db"; exit 1; }
    echo "$db"
    return
  fi

  local pvc_name=$(kubectl get deployment bf42-stats -n "$NS" -o jsonpath='{.spec.template.spec.volumes[?(@.persistentVolumeClaim)].persistentVolumeClaim.claimName}' 2>/dev/null)
  if [ -z "$pvc_name" ]; then
    log "ERROR: Could not find bf42-stats PVC name from deployment"
    exit 1
  fi

  db=$(find /var/lib/rancher/k3s/storage /mnt -maxdepth 5 -type f -name "playertracker.db" 2>/dev/null | head -1)
  if [ -z "$db" ]; then
    log "ERROR: Could not find playertracker.db in known mount paths"
    log "Hint: Set DB_PATH parameter with the correct path"
    exit 1
  fi

  log "Located database at: $db"
  echo "$db"
}

compress_and_report() {
  local backup_file="$1"
  local name="$2"

  log "Compressing $name with zstd (ultra mode, long-range matching, all cores)..."
  start=$(date +%s)
  zstd -f --ultra --long -T0 "$backup_file" -o "$backup_file.zst"
  end=$(date +%s)
  elapsed=$((end - start))

  local backup_file_zst="${backup_file}.zst"
  local compressed_size=$(du -sh "$backup_file_zst" | cut -f1)
  local original_size=$(du -sh "$backup_file" | cut -f1)
  local compression_ratio=$(echo "scale=1; $(stat -c%s "$backup_file") * 100 / $(stat -c%s "$backup_file_zst")" | bc)
  log "$name compression complete (${elapsed}s, ${original_size} → ${compressed_size}, ${compression_ratio}%)"

  echo "$backup_file_zst"
}

upload_to_azure() {
  local backup_file="$1"
  local name="$2"

  log "Uploading $name to Azure..."
  start=$(date +%s)
  # </dev/null is load-bearing: runbooks run as `bash -s` with the script itself
  # on stdin, and azcopy reads stdin for lifecycle messages — without this it
  # swallows the rest of the script and bash silently exits at EOF.
  azcopy copy "$backup_file" "${AZURE_SAS_URL}" --overwrite=true </dev/null
  end=$(date +%s)
  elapsed=$((end - start))

  log "$name upload complete (${elapsed}s)"
}

# Phase 7 restores the cluster as soon as the copies are done, so the trap only
# has to back out an *early* exit. Guarded on a state flag rather than $? because
# the failure mode we actually hit (azcopy eating the script off stdin) exits 0 —
# an exit-code guard would have left Neo4j scaled to 0. Backups always cleaned up.
restored=0
trap 'if [ "${restored:-0}" -ne 1 ]; then
        log "Backing out: re-enabling background processing and restarting Neo4j..."
        kubectl set env deployment/"${APP_DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=false >&2 || true
        kubectl scale deployment/"${NEO4J_DEP}" -n "${NS}" --replicas=1 >&2 || true
        kubectl rollout status deployment/"${APP_DEP}" -n "${NS}" --timeout=120s >&2 || true
      fi
      log "Cleaning up backup files from ${BACKUP_DIR}..."
      rm -f "${BACKUP_DIR}"/bfstats-neo4j-latest.* "${BACKUP_DIR}"/bfstats-sqlite-latest.* 2>/dev/null || true' EXIT

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

# ── Phase 3: locate Neo4j PVC and SQLite DB ───────────────────────────────────
pvc_path=$(locate_pvc "$NEO4J_DEP" "${NEO4J_PVC_PATH:-}")
pvc_size=$(du -sh "$pvc_path" | cut -f1)
log "Neo4j data directory located (size: ${pvc_size})"

db=$(locate_db "${DB_PATH:-}")
db_size=$(du -sh "$db" | cut -f1)
log "SQLite database located (size: ${db_size})"

# ── Phase 5: archive Neo4j PVC to tar ─────────────────────────────────────────
neo4j_backup_file="${BACKUP_DIR}/bfstats-neo4j-latest.tar"
log "Archiving Neo4j data to ${neo4j_backup_file}..."

start=$(date +%s)
tar -cf "$neo4j_backup_file" -C "$pvc_path" .
end=$(date +%s)
elapsed=$((end - start))

neo4j_backup_size=$(du -sh "$neo4j_backup_file" | cut -f1)
log "Archive complete (${elapsed}s, size: ${neo4j_backup_size})"

# ── Phase 6: checkpoint SQLite WAL and copy to backup dir ──────────────────────
log "Checkpointing SQLite WAL (TRUNCATE mode)..."
start=$(date +%s)
sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
end=$(date +%s)
log "Checkpoint complete ($((end - start))s)"

# Sanity check: if a -wal file still exists after TRUNCATE it means there are
# uncommitted transactions — abort rather than copy a potentially dirty state.
wal_size=$(stat -c%s "${db}-wal" 2>/dev/null || echo 0)
if [ "$wal_size" -gt 0 ]; then
  log "ERROR: WAL file is non-empty after TRUNCATE checkpoint — aborting to protect data integrity"
  exit 1
fi

sqlite_backup_file="${BACKUP_DIR}/bfstats-sqlite-latest.db"
log "Copying SQLite database to ${sqlite_backup_file}..."

start=$(date +%s)
cp "$db" "$sqlite_backup_file"
end=$(date +%s)
elapsed=$((end - start))

sqlite_backup_size=$(du -sh "$sqlite_backup_file" | cut -f1)
log "Copy complete (${elapsed}s, size: ${sqlite_backup_size})"

# ── Phase 7: re-enable background processing and restart Neo4j ────────────────
log "Re-enabling background processing and restarting Neo4j..."
kubectl set env deployment/"${APP_DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=false >&2
kubectl scale deployment/"${NEO4J_DEP}" -n "${NS}" --replicas=1 >&2
restored=1   # cluster is back to normal — the trap must not redo this
kubectl rollout status deployment/"${APP_DEP}" -n "${NS}" --timeout=120s >&2

# ── Phase 8: compress both files with zstd ───────────────────────────────────
neo4j_backup_file_zst=$(compress_and_report "$neo4j_backup_file" "Neo4j backup")
neo4j_compressed_size=$(du -sh "$neo4j_backup_file_zst" | cut -f1)

sqlite_backup_file_zst=$(compress_and_report "$sqlite_backup_file" "SQLite backup")
sqlite_compressed_size=$(du -sh "$sqlite_backup_file_zst" | cut -f1)

# ── Phase 9: upload both to Azure ─────────────────────────────────────────────
upload_to_azure "$neo4j_backup_file_zst" "Neo4j backup"
upload_to_azure "$sqlite_backup_file_zst" "SQLite backup"

echo "" >&2
log "✓ Both backups complete and uploaded to Azure"
log "Neo4j file: $(basename "$neo4j_backup_file_zst") (${neo4j_compressed_size})"
log "SQLite file: $(basename "$sqlite_backup_file_zst") (${sqlite_compressed_size})"
echo "" >&2

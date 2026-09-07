#!/usr/bin/env bash
# bfstats-backup-sqlite — disable background jobs, checkpoint WAL, compress, upload to Azure
#
# Disables DISABLE_BACKGROUND_PROCESSING to pause all database writes while keeping the API
# running for read traffic. Waits for the background jobs to shut down, then performs an
# explicit WAL checkpoint (TRUNCATE mode) to guarantee a consistent snapshot, copies the
# raw binary DB file to /backup, compresses with zstd (parallel), and uploads to Azure.
# Logs progress with timestamps. Re-enables background jobs immediately after upload completes.
#
# No SQLite connection is open during the copy, so it's impossible for the backup to affect
# the primary database. Uncompressed file is deleted after successful upload.
#
# params:
#   DEPLOYMENT: { label: "k3s deployment name for the app", default: "bf42-stats" }
#   NAMESPACE:  { label: "k3s namespace", default: "bf42-stats" }
#   DB_PATH:    { label: "Path to sqlite db (blank = auto-locate on k3s PVC)" }
#   BACKUP_DIR: { label: "Host backup directory", default: "/backup" }
#   AZURE_SAS_URL: { label: "Azure Blob SAS URL (e.g., https://account.blob.core.windows.net/container?sv=...)", required: true }
# nodes: [ hetzner/bfstats ]
# confirm: This will pause background jobs (API reads stay online), backup to Azure (~15-20 min total). Continue?

set -euo pipefail

command -v kubectl  >/dev/null 2>&1 || { echo "kubectl not installed on host" >&2; exit 2; }
command -v sqlite3  >/dev/null 2>&1 || { echo "sqlite3 not installed on host" >&2; exit 2; }
command -v zstd     >/dev/null 2>&1 || { echo "Installing zstd..." >&2; apt-get update && apt-get install -y zstd >&2; }
command -v bc       >/dev/null 2>&1 || { echo "Installing bc..." >&2; apt-get install -y bc >&2; }
command -v azcopy   >/dev/null 2>&1 || { echo "Installing azcopy..." >&2; curl -sL https://aka.ms/downloadazcopy-v10-linux-arm64 -o /tmp/azcopy.tar.gz && tar -xzf /tmp/azcopy.tar.gz -C /tmp && sudo mv /tmp/azcopy_linux_arm64_*/azcopy /usr/local/bin/ && chmod +x /usr/local/bin/azcopy >&2; }
[ -z "${AZURE_SAS_URL:-}" ] && { echo "AZURE_SAS_URL parameter is required" >&2; exit 1; }

NS="${NAMESPACE:-bf42-stats}"
DEP="${DEPLOYMENT:-bf42-stats}"
BACKUP_DIR="${BACKUP_DIR:-/backup}"

log() { echo "[$(date +'%H:%M:%S')] $*" >&2; }

# On error, try to re-enable background processing before exiting
trap 'if [ $? -ne 0 ]; then log "ERROR: backing out, re-enabling background processing..."; kubectl set env deployment/"${DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=false >&2; fi' EXIT

# ── Phase 1: disable background processing ───────────────────────────────────
log "Disabling background processing (API reads stay online)..."
kubectl set env deployment/"${DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=true >&2

log "Waiting for rollout to complete (pods restarting)..."
kubectl rollout status deployment/"${DEP}" -n "${NS}" --timeout=120s >&2

# Create backup directory if needed
mkdir -p "$BACKUP_DIR"

# Locate the SQLite DB
db="${DB_PATH:-}"
if [ -z "$db" ]; then
  # Query kubectl to find the bf42-stats PVC name dynamically
  pvc_name=$(kubectl get deployment bf42-stats -n "$NS" -o jsonpath='{.spec.template.spec.volumes[?(@.persistentVolumeClaim)].persistentVolumeClaim.claimName}' 2>/dev/null)
  if [ -z "$pvc_name" ]; then
    log "ERROR: Could not find bf42-stats PVC name from deployment"
    exit 1
  fi

  # Search mount points for the PVC (could be /var/lib/rancher/k3s/storage or /mnt or elsewhere)
  db=$(find /var/lib/rancher/k3s/storage /mnt -maxdepth 5 -type f -name "playertracker.db" 2>/dev/null | head -1)
  if [ -z "$db" ]; then
    log "ERROR: Could not find playertracker.db in known mount paths"
    log "Hint: Set DB_PATH parameter with the correct path"
    exit 1
  fi
  log "Located database at: $db"
fi
[ -f "$db" ] || { log "ERROR: SQLite DB not found: $db"; exit 1; }

db_size=$(du -sh "$db" | cut -f1)
log "Database located: $db (size: ${db_size})"

# ── Phase 2: explicit WAL checkpoint ─────────────────────────────────────────
log "Checkpointing WAL (TRUNCATE mode)..."
start=$(date +%s)
sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
end=$(date +%s)
log "Checkpoint complete ($((end - start))s)"

# Sanity check: if a -wal file still exists after TRUNCATE it means there are
# uncommitted transactions — abort rather than copy a potentially dirty state.
if [ -f "${db}-wal" ] && [ "$(wc -c < "${db}-wal}")" -gt 0 ]; then
  log "ERROR: WAL file is non-empty after TRUNCATE checkpoint — aborting to protect data integrity"
  exit 1
fi

# ── Phase 3: copy to host SSD ────────────────────────────────────────────────
backup_file="${BACKUP_DIR}/bfstats-sqlite-latest.db"
log "Copying to ${backup_file}..."

start=$(date +%s)
cp "$db" "$backup_file"
end=$(date +%s)
elapsed=$((end - start))

backup_size=$(du -sh "$backup_file" | cut -f1)
log "Copy complete (${elapsed}s, size: ${backup_size})"

# Re-enable background processing now that the database is no longer accessed
log "Re-enabling background processing (API writes resuming)..."
kubectl set env deployment/"${DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=false >&2

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
log "Uploading to Azure (${compressed_size})..."
start=$(date +%s)
azcopy copy "$backup_file_zst" "${AZURE_SAS_URL}/" --overwrite=true
end=$(date +%s)
elapsed=$((end - start))

log "Upload complete (${elapsed}s)"

# ── Phase 6: cleanup ─────────────────────────────────────────────────────────
log "Cleaning up backup files..."
rm -f "$backup_file" "$backup_file_zst"

echo "" >&2
log "✓ Backup complete and uploaded to Azure"
log "File: $(basename "$backup_file_zst")"
log "Size: ${compressed_size}"
echo "" >&2

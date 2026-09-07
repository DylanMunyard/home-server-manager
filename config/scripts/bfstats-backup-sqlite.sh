#!/usr/bin/env bash
# bfstats-backup-sqlite — disable background jobs, checkpoint WAL, copy DB to host SSD
#
# Disables DISABLE_BACKGROUND_PROCESSING to pause all database writes while keeping the API
# running for read traffic. Waits for the background jobs to shut down, then performs an
# explicit WAL checkpoint (TRUNCATE mode) to guarantee a consistent snapshot, and copies the
# raw binary DB file to /backup on the host SSD. Logs progress with timestamps.
# No SQLite connection is open during the copy, so it's impossible for the backup to affect
# the primary database. Re-enables background jobs immediately after the copy completes.
#
# Output path and scp command for manual download.
#
# params:
#   DEPLOYMENT: { label: "k3s deployment name for the app", default: "bf42-stats" }
#   NAMESPACE:  { label: "k3s namespace", default: "bf42-stats" }
#   DB_PATH:    { label: "Path to sqlite db (blank = auto-locate on k3s PVC)" }
#   BACKUP_DIR: { label: "Host backup directory", default: "/backup" }
# nodes: [ hetzner/bfstats ]
# confirm: This will pause background jobs (API reads stay online) while the database is backed up (~2-5 min). Continue?

set -euo pipefail

command -v kubectl  >/dev/null 2>&1 || { echo "kubectl not installed on host" >&2; exit 2; }
command -v sqlite3  >/dev/null 2>&1 || { echo "sqlite3 not installed on host" >&2; exit 2; }

NS="${NAMESPACE:-bf42-stats}"
DEP="${DEPLOYMENT:-bf42-stats}"
BACKUP_DIR="${BACKUP_DIR:-/backup}"

log() { echo "[$(date +'%H:%M:%S')] $*" >&2; }

# Re-enable background processing on exit (success or failure)
trap 'log "Re-enabling background processing..."; kubectl set env deployment/"${DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=false --record >&2' EXIT

# ── Phase 1: disable background processing ───────────────────────────────────
log "Disabling background processing (API reads stay online)..."
kubectl set env deployment/"${DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=true --record >&2

log "Waiting for rollout to complete (pods restarting)..."
kubectl rollout status deployment/"${DEP}" -n "${NS}" --timeout=120s >&2

# Create backup directory if needed
mkdir -p "$BACKUP_DIR"

# Locate the SQLite DB
db="${DB_PATH:-}"
if [ -z "$db" ]; then
  set +f
  set -- /var/lib/rancher/k3s/storage/pvc-*_bf42-stats_*/playertracker.db
  set -f
  db="$1"
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
backup_file="${BACKUP_DIR}/bfstats-sqlite-$(date +%Y%m%d-%H%M%S).db"
log "Copying to ${backup_file}..."

start=$(date +%s)
cp "$db" "$backup_file"
end=$(date +%s)
elapsed=$((end - start))

backup_size=$(du -sh "$backup_file" | cut -f1)
log "Copy complete (${elapsed}s, size: ${backup_size})"

echo "" >&2
log "✓ Backup complete"
log "Path: $backup_file"
log "Size: ${db_size}"
echo "" >&2
echo "Download with:" >&2
echo "  scp hetzner:$backup_file ./" >&2
echo "" >&2

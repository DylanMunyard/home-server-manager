#!/usr/bin/env bash
# bfstats-backup-sqlite — stop bfstats, checkpoint WAL, stream DB file to stdout (gzipped), restart
#
# Scales the bf42-stats deployment to 0 and waits for the pod to terminate.
# When the last connection closes, SQLite auto-checkpoints the WAL back into the
# main DB file. We then run a second explicit PRAGMA wal_checkpoint(TRUNCATE)
# to guarantee the WAL is fully merged and removed, then stream the raw binary
# DB file via `gzip -c` — no SQLite connection is open during the actual copy,
# so it is impossible for the backup to affect the primary database.
#
# Output is a gzipped binary SQLite file (.db.gz). Restore: gunzip > playertracker.db
#
# params:
#   DEPLOYMENT: { label: "k3s deployment name for the app", default: "bf42-stats" }
#   NAMESPACE:  { label: "k3s namespace", default: "bf42-stats" }
#   DB_PATH:    { label: "Path to sqlite db (blank = auto-locate on k3s PVC)" }
# nodes: [ hetzner/bfstats ]
# confirm: This will stop the bf42-stats deployment, checkpoint the SQLite database, then restart it. The app will be unavailable for ~30–60s. Continue?

set -euo pipefail

command -v kubectl  >/dev/null 2>&1 || { echo "kubectl not installed on host" >&2; exit 2; }
command -v sqlite3  >/dev/null 2>&1 || { echo "sqlite3 not installed on host" >&2; exit 2; }
command -v gzip     >/dev/null 2>&1 || { echo "gzip not installed on host" >&2; exit 2; }

NS="${NAMESPACE:-bf42-stats}"
DEP="${DEPLOYMENT:-bf42-stats}"

# Restart the deployment on exit (success or failure) so the app always comes back.
trap 'echo "Restarting ${DEP}..." >&2; kubectl scale deployment/"${DEP}" -n "${NS}" --replicas=1 >&2' EXIT

echo "Scaling down ${NS}/${DEP}..." >&2
kubectl scale deployment/"${DEP}" -n "${NS}" --replicas=0 >&2

echo "Waiting for pod to terminate (SQLite auto-checkpoints on last connection close)..." >&2
kubectl wait --for=delete pod -l "app=${DEP}" -n "${NS}" --timeout=90s >&2 2>/dev/null || true

# Locate the SQLite DB
db="${DB_PATH:-}"
if [ -z "$db" ]; then
  set +f
  set -- /var/lib/rancher/k3s/storage/pvc-*_bf42-stats_*/playertracker.db
  set -f
  db="$1"
fi
[ -f "$db" ] || { echo "SQLite DB not found: $db" >&2; exit 1; }

# ── Phase 1: explicit WAL checkpoint ─────────────────────────────────────────
# SQLite auto-checkpoints when the last connection closes, but we make it
# explicit and use TRUNCATE mode to remove the WAL file entirely. This is the
# only write operation and uses a dedicated, short-lived connection.
echo "Checkpointing WAL (TRUNCATE)..." >&2
sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null

# Sanity check: if a -wal file still exists after TRUNCATE it means there are
# uncommitted transactions — abort rather than copy a potentially dirty state.
if [ -f "${db}-wal" ] && [ "$(wc -c < "${db}-wal")" -gt 0 ]; then
  echo "WAL file is non-empty after TRUNCATE checkpoint — aborting to protect data integrity" >&2
  exit 1
fi

# ── Phase 2: stream raw binary file ──────────────────────────────────────────
# gzip -c reads the file as plain bytes. No SQLite connection is opened.
# The primary database file cannot be affected by this step.
echo "Streaming ${db} ($(du -sh "$db" | cut -f1)) ..." >&2
gzip -c "$db"

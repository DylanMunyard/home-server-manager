#!/usr/bin/env bash
# bfstats-db-health — SQLite file sizes, WAL state, and biggest tables
#
# Read-only snapshot of the playertracker.db backing bfstats.io: main / -wal /
# -shm file sizes (a -wal past a few hundred MB means checkpointing is being
# starved by long-running readers), journal mode + freelist, and the top tables
# and indexes by on-disk size via dbstat. Auto-locates the DB on the k3s
# local-path PVC; set DB_PATH to point anywhere else. Safe to run against the
# live DB — opens read-only, never takes the write lock.
#
# params:
#   DB_PATH: { label: "Path to sqlite db (blank = auto-locate on k3s PVC)" }
#   TABLES:  { label: "Top tables to list", default: "12" }
# nodes: [ hetzner/bfstats ]

set -euo pipefail

command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 not installed on host"; exit 2; }

db="$DB_PATH"
if [ -z "$db" ]; then
  set -- /var/lib/rancher/k3s/storage/pvc-*_bf42-stats_*/playertracker.db
  db="$1"
fi
[ -f "$db" ] || { echo "db not found: $db"; exit 2; }

echo "== files =="
ls -lh "$db" "$db"-wal "$db"-shm 2>/dev/null || true

echo
echo "== pragmas =="
sqlite3 -readonly "$db" "
  SELECT 'journal_mode:  ' || journal_mode FROM pragma_journal_mode;
  SELECT 'page_size:     ' || page_size FROM pragma_page_size;
  SELECT 'freelist:      ' || freelist_count || ' pages' FROM pragma_freelist_count;
  SELECT 'integrity(1):  ' || integrity_check FROM pragma_integrity_check(1);"

echo
echo "== biggest tables + indexes (MB on disk) =="
sqlite3 -readonly -header -column "$db" "
  SELECT name, SUM(pgsize)/1024/1024 AS mb
  FROM dbstat GROUP BY name ORDER BY mb DESC LIMIT ${TABLES};" \
  2>/dev/null || echo "dbstat unavailable in this sqlite3 build — skipping table breakdown"

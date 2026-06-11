#!/usr/bin/env bash
# bfstats-close-stale-rounds — close rounds stuck IsActive past a sane age
#
# Remediation pair of bfstats-stale-rounds: every active round older than
# MAX_AGE_HOURS gets IsActive=0 and EndTime = StartTime + 60 minutes (a guess
# at when the real round ended — the schema requires EndTime >= StartTime, and
# a bounded duration is what defuses the round-report snapshot loop). Prints
# the rounds it's about to touch, then the number of rows changed.
#
# WRITES to the live DB. That's safe — SQLite serializes writers via file
# locks and the 5s busy timeout below — but already-running zombie report
# requests keep their in-memory copy of the old data: restart the api pod
# after closing if CPU is currently pinned.
#
# confirm: Closes (IsActive=0, EndTime=StartTime+60min) every active round older than MAX_AGE_HOURS. Run bfstats-stale-rounds first to review the list. Continue?
#
# params:
#   MAX_AGE_HOURS: { label: "Max age for an active round (hours)", default: "24" }
#   DB_PATH:       { label: "Path to sqlite db (blank = auto-locate on k3s PVC)" }
# nodes: [ hetzner/bfstats ]

set -euo pipefail

command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 not installed on host"; exit 2; }
[[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || { echo "MAX_AGE_HOURS must be a whole number"; exit 2; }

db="$DB_PATH"
if [ -z "$db" ]; then
  set -- /var/lib/rancher/k3s/storage/pvc-*_bf42-stats_*/playertracker.db
  db="$1"
fi
[ -f "$db" ] || { echo "db not found: $db"; exit 2; }

where="IsActive = 1 AND StartTime < datetime('now', '-${MAX_AGE_HOURS} hours')"

echo "== closing these rounds =="
sqlite3 -readonly -header -column "$db" "
  SELECT RoundId, ServerName, StartTime FROM Rounds WHERE $where ORDER BY StartTime ASC;"
echo

changed=$(sqlite3 -cmd ".timeout 5000" "$db" "
  UPDATE Rounds SET IsActive = 0, EndTime = datetime(StartTime, '+60 minutes') WHERE $where;
  SELECT changes();")

echo "closed $changed round(s)"
[ "$changed" -gt 0 ] && echo "if CPU is pinned by in-flight report requests, restart the api pod to kill them"
exit 0

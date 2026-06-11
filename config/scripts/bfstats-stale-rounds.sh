#!/usr/bin/env bash
# bfstats-stale-rounds — flag rounds stuck IsActive past a sane age
#
# A round left IsActive=1 with no EndTime (server-GUID merges can orphan these)
# makes /stats/rounds/{id}/report iterate one leaderboard snapshot per minute
# since StartTime — a months-old zombie means an effectively unbounded CPU loop
# per request. That's the June 2026 incident: one round active since Sep 2025,
# nine piled-up report requests, three cores pinned, live player counts blanked.
#
# Lists any active round older than MAX_AGE_HOURS and exits 1 when found, so a
# recurring job can alert on it (when: exit nonzero) or chain
# bfstats-close-stale-rounds as remediation. Read-only.
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

count=$(sqlite3 -readonly "$db" "SELECT COUNT(*) FROM Rounds WHERE $where;")

if [ "$count" -eq 0 ]; then
  echo "OK — no active rounds older than ${MAX_AGE_HOURS}h"
  exit 0
fi

echo "FOUND $count stale active round(s) older than ${MAX_AGE_HOURS}h:"
echo
sqlite3 -readonly -header -column "$db" "
  SELECT RoundId, ServerName, StartTime,
         CAST((julianday('now') - julianday(StartTime)) * 24 AS INTEGER) AS hours_open
  FROM Rounds WHERE $where ORDER BY StartTime ASC;"
echo
echo "remediate with the bfstats-close-stale-rounds runbook"
exit 1

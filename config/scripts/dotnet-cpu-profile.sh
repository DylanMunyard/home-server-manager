#!/usr/bin/env bash
# dotnet-cpu-profile — sample CPU with perf and break it down by library
#
# Records DURATION seconds of cycle samples for the busiest matching process
# and prints a flat (self-time) per-library table plus the top symbols. This
# answers "WHERE is the CPU going" at the native level; pair it with
# dotnet-hot-threads to put C# method names on managed time. Legend:
#
#   memfd:doublemapper   your managed (JIT-compiled) code — perf cannot name
#                        managed methods on an already-running process
#   libcoreclr.so        .NET runtime (GC bookkeeping, type checks, interop)
#   libclrgc.so          GC proper — big share = allocation churn
#   libe_sqlite3.so      SQLite query execution
#   [kernel.kallsyms]    syscalls / IO
#
# Read-only sampling (~no overhead at these durations); the perf.data temp file
# is deleted on exit. Needs perf on the host: Debian `apt-get install
# linux-perf`, Ubuntu `linux-tools-$(uname -r)`. Don't pass -g on ARM64 — the
# DWARF unwinder chokes on JIT'd frames; this flat view is the reliable one.
#
# params:
#   PROC:     { label: "Process name to sample", default: dotnet }
#   DURATION: { label: "Seconds to sample", default: "15" }

set -euo pipefail

command -v perf >/dev/null 2>&1 \
  || { echo "perf not installed — Debian: apt-get install linux-perf | Ubuntu: apt-get install linux-tools-\$(uname -r)"; exit 2; }

PID=$(ps -eo pid,pcpu,comm --sort=-pcpu | awk -v p="$PROC" '$3 == p { print $1; exit }')
[ -n "${PID:-}" ] || { echo "no '$PROC' process found"; exit 2; }

out=$(mktemp /tmp/hsm-perf.XXXXXX)
trap 'rm -f "$out"' EXIT

echo "sampling pid $PID for ${DURATION}s..."
perf record -q -o "$out" -p "$PID" -- sleep "$DURATION"

echo
echo "== self time by library =="
perf report -i "$out" --stdio --no-children --sort dso 2>/dev/null | grep -v '^#' | awk 'NF' | head -12

echo
echo "== top symbols =="
perf report -i "$out" --stdio --no-children --sort dso,symbol 2>/dev/null | grep -v '^#' | awk 'NF' | head -20

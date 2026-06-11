#!/usr/bin/env bash
# dotnet-hot-threads — which .NET threads are burning CPU, and what code they're running
#
# Two views of the busiest matching process: a per-thread CPU table (ps -L),
# then a condensed managed stack for every thread currently ON CPU — method
# names only, argument signatures and GC-poll noise stripped — so the hot code
# path reads at a glance. Stacks come from Microsoft's dotnet-stack single-file
# tool: downloaded to /tmp on first use, copied into the target container's
# filesystem via /proc/<pid>/root, and executed inside its namespaces with
# nsenter — works for containerized processes (k3s) with no kubectl and no SDK
# in the image. Read-only: attaches via the runtime's diagnostic socket; no
# restart, negligible pause. Needs root (nsenter) and curl on the host.
#
# Same-thread-still-on-CPU across two runs a few seconds apart = a long-running
# loop, not throughput. That pattern is how the June 2026 bfstats round-report
# zombie loops were caught.
#
# params:
#   PROC:   { label: "Process name to inspect", default: dotnet }
#   FRAMES: { label: "Stack frames per busy thread", default: "8" }
#   VIEW:   { label: "Which stacks to print", default: busy, choices: [busy, all] }

set -euo pipefail

PID=$(ps -eo pid,pcpu,comm --sort=-pcpu | awk -v p="$PROC" '$3 == p { print $1; exit }')
[ -n "${PID:-}" ] || { echo "no '$PROC' process found"; exit 2; }

echo "== $PROC pid $PID — threads by CPU (cumulative since thread start) =="
ps -Lp "$PID" -o tid,pcpu,time,comm --sort=-pcpu | head -16
echo

# Fetch the diagnostic tool once per host; arch-specific single-file build.
case "$(uname -m)" in
  aarch64) arch=arm64 ;;
  x86_64)  arch=x64 ;;
  *) echo "unsupported arch $(uname -m)"; exit 2 ;;
esac
tool="/tmp/dotnet-stack-$arch"
if [ ! -x "$tool" ]; then
  echo "downloading dotnet-stack ($arch)..."
  curl -fsSL "https://aka.ms/dotnet-stack/linux-$arch" -o "$tool"
  chmod +x "$tool"
fi

# NSpid's last field is the pid as the container sees it (equals $PID when the
# process isn't containerized — every step below degrades gracefully to that).
nspid=$(awk '/^NSpid:/ { print $NF }' "/proc/$PID/status")
cp "$tool" "/proc/$PID/root/tmp/dotnet-stack"

echo "== managed stacks (container pid $nspid) =="
report=$(nsenter -t "$PID" -m -p -- /tmp/dotnet-stack report -p "$nspid")

if [ "$VIEW" = "all" ]; then
  printf '%s\n' "$report"
  exit 0
fi

printf '%s\n' "$report" | awk -v max="$FRAMES" '
  /^Thread \(/ {
    tid = $2; gsub(/[():]/, "", tid)
    expect = 1; busy = 0; n = 0; total++
    next
  }
  expect {
    expect = 0
    if ($0 ~ /CPU_TIME/) { busy = 1; nb++; printf "\nThread %s — ON CPU\n", tid; next }
  }
  busy && NF && n < max {
    line = $0
    gsub(/^[ \t]+/, "", line)
    sub(/\(.*$/, "", line)            # drop argument signatures
    if (line ~ /PollGCWorker/) next   # GC-poll noise, not the real frame
    printf "  %s\n", line
    n++
    next
  }
  !NF { busy = 0 }
  END {
    printf "\n%d of %d threads on CPU", nb, total
    if (nb == 0) printf " — nothing burning right now; VIEW=all shows waiting threads too"
    printf "\n"
  }'

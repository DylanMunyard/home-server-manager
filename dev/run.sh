#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

prefix() {
  local tag="$1" color="$2" reset=$'\033[0m'
  while IFS= read -r line; do
    printf '%b[%s]%b %s\n' "$color" "$tag" "$reset" "$line"
  done
}

ensure_deps() {
  local dir="$1"
  if [[ ! -d "$dir/node_modules" ]]; then
    echo "==> installing deps in $dir"
    (cd "$dir" && npm install)
  fi
}

# Kill any stale instance still holding our ports (the API binds 5781, Vite
# 5780) so a previous run that didn't clean up doesn't cause EADDRINUSE. We
# target the ports specifically — not a broad `pkill node` — so unrelated Node
# apps are left alone. Honours a custom $PORT for the API.
free_ports() {
  local port pids
  for port in 5780 "${PORT:-5781}"; do
    if command -v lsof >/dev/null 2>&1; then
      pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
    elif command -v fuser >/dev/null 2>&1; then
      pids="$(fuser "$port/tcp" 2>/dev/null || true)"
    else
      pids="$(ss -ltnp 2>/dev/null | grep -oP "(?<=:$port )[^\n]*pid=\K[0-9]+" || true)"
    fi
    if [[ -n "$pids" ]]; then
      echo "==> freeing port $port (killing: $(echo "$pids" | tr '\n' ' '))"
      kill $pids 2>/dev/null || true
      sleep 0.5
      kill -9 $pids 2>/dev/null || true
    fi
  done
}

ensure_deps "$root/api"
ensure_deps "$root/ui"

free_ports

pids=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${pids[@]}"; do
    kill -- "-$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

set -m
(cd "$root/api" && npm run dev 2>&1 | prefix "api" $'\033[33m') &
pids+=("$!")
(cd "$root/ui"  && npm run dev 2>&1 | prefix "ui"  $'\033[36m') &
pids+=("$!")
set +m

wait

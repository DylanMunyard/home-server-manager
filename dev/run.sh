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

ensure_deps "$root/api"
ensure_deps "$root/ui"

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

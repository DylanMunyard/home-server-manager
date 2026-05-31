#!/usr/bin/env bash
# fs-list — stream a directory's children, then per-folder recursive sizes (NDJSON)
#
# Two phases over one SSH exec channel so the browser paints instantly and fills
# sizes in live (the dashboard's streaming ethos — no blocking on a 27T `du`):
#   1) {"t":"entry",...} per immediate child — files carry real sizes, dirs 0.
#   2) {"t":"size","path","size"} per directory as `du` finishes it, streamed,
#      so the folder list shows at once and the big-folder sizes trickle in.
# Ends with {"t":"done"}. Zero-install (find + du + awk), no sudo, no TTY. Run by
# the file routes over `bash -s`; loops nothing — it exits when sizing is done.
#
# params:
#   FB_PATH: { label: Directory to list, required: true }

set -euo pipefail
dir="${FB_PATH:?FB_PATH is required}"
[ -d "$dir" ] || { echo "not a directory: $dir" >&2; exit 2; }

# Phase 1 — immediate listing: type/size/mtime/path for every child. Files get
# their real size; directories report 0 here (their recursive size streams in
# phase 2). awk handles JSON-escaping of names/paths.
find "$dir" -maxdepth 1 -mindepth 1 -printf '%y\t%s\t%T@\t%p\n' 2>/dev/null | awk -F'\t' '
function esc(s,  r){ r=s; gsub(/\\/,"\\\\",r); gsub(/"/,"\\\"",r); return r }
{
  type=$1; size=$2+0; mtime=$3; path=$4
  sub(/\..*/, "", mtime)
  kind=(type=="d")?"dir":(type=="f")?"file":"other"
  if (kind=="dir") size=0
  name=path; sub(/.*\//, "", name)
  # %.0f, not %d: byte counts exceed 2^31, and mawk %d truncates to 32-bit.
  printf "{\"t\":\"entry\",\"name\":\"%s\",\"path\":\"%s\",\"type\":\"%s\",\"size\":%.0f,\"mtime\":%.0f}\n", \
    esc(name), esc(path), kind, size, mtime+0
  fflush()   # stream each row as find yields it — a huge dir shows rows at once
}' || true

# Phase 2 — recursive size per directory (-x stays on one filesystem). du runs
# one directory at a time; each result pipes straight through awk which fflushes,
# so sizes stream as they complete rather than landing all at once at the end.
find "$dir" -maxdepth 1 -mindepth 1 -type d -print0 2>/dev/null \
  | while IFS= read -r -d '' d; do du -sx -B1 -- "$d" 2>/dev/null || true; done \
  | awk -F'\t' '
function esc(s,  r){ r=s; gsub(/\\/,"\\\\",r); gsub(/"/,"\\\"",r); return r }
{ printf "{\"t\":\"size\",\"path\":\"%s\",\"size\":%.0f}\n", esc($2), $1+0; fflush() }' || true

printf '{"t":"done"}\n'

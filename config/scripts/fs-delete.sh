#!/usr/bin/env bash
# fs-delete — permanently remove a file or directory (rm -rf)
#
# DESTRUCTIVE. Used by the file browser's delete action; the API guards the path
# first, this is the second line of defence. No OS trash on a remote host — gone
# is gone. Zero-install, no sudo, no TTY.
#
# confirm: "This permanently deletes the path via rm -rf over SSH — there is no trash. Run it anyway?"
#
# params:
#   FB_PATH: { label: Path to delete, required: true }

set -euo pipefail

path="${FB_PATH:?FB_PATH is required}"

case "$path" in
  /*) ;;                       # must be absolute
  *)  echo "refusing: path must be absolute" >&2; exit 2 ;;
esac
[ "$path" = "/" ] && { echo "refusing to delete /" >&2; exit 2; }

rm -rf -- "$path"
echo "deleted: $path"

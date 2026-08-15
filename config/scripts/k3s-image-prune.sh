#!/usr/bin/env bash

# k3s-image-prune — reclaim disk by deleting superseded (untagged) container images
#
# Every CI push replaces a `:latest` tag, which orphans the image it displaced.
# Nothing collects those: k3s's own image GC is threshold-driven
# (imageGCHighThresholdPercent, 85% disk by default), so a node sitting below
# the line accumulates forever and then evicts pods the moment it crosses.
# On hetzner/bfstats ~180 builds had grown the containerd store to 17G — larger
# than the 24G SQLite DB it was nominally there to host. Pruning took it to 8.6G.
#
# Safety is layered, because this deletes things on a live node:
#   1. Only images with NO tag (`<none>`) are candidates. A tag is a declared
#      intent — `:latest`, `5-community`, `3.2-alpine` are never touched.
#   2. Candidates referenced by any container (running OR exited) are skipped.
#      An exited container still pins its image for a restart/rollback.
#   3. Deletes are per-image and failures are counted, not fatal — one image
#      wedged by a stale snapshot must not abort the sweep.
#
# The in-use scan is deliberately over-inclusive: it greps every `sha256:` digest
# out of the runtime's container list rather than parsing a specific JSON field.
# A false positive costs a few hundred MB left on disk; a false negative deletes
# an image out from under a running pod.
#
# Caveat worth knowing: `kubectl rollout undo` references the previous
# ReplicaSet's image, which by then is untagged and therefore prunable. If it's
# gone the node re-pulls from the registry, which is fine — unless you're rolling
# back during a registry outage. Fortnightly cadence keeps that window small.
#
# Zero-install: crictl only (via `k3s crictl` on k3s nodes). No-ops with exit 0
# on a host that runs neither, so a job can safely fan out across mixed targets.
#
# params:
#   PRUNE_REPOS:   { label: "Only prune these repos (space-separated substrings; empty = all)", default: "" }
#   PRUNE_DRY_RUN: { label: "Dry run — list what would go, delete nothing", default: "no", choices: ["no", "yes"] }

# NOTE: no `-e`. Individual `rmi` failures are expected and handled explicitly
# below; aborting the sweep on the first one would leave the bulk unreclaimed.
set -uo pipefail

# --- 0. Locate a container runtime, or degrade harmlessly ---------------------
if command -v k3s >/dev/null 2>&1 && k3s crictl version >/dev/null 2>&1; then
    CRICTL="k3s crictl"
elif command -v crictl >/dev/null 2>&1; then
    CRICTL="crictl"
else
    echo "no crictl / k3s on this host — nothing to prune"
    exit 0
fi

used_before="$(df -B1 / | awk 'NR==2 {print $3}')"
pct_before="$(df -h / | awk 'NR==2 {print $5}')"

# --- 1. Which image IDs are spoken for? --------------------------------------
# `ps -a` includes exited containers on purpose (see header). Grepping every
# digest out of the blob is the over-inclusive-by-design bit.
inuse="$($CRICTL ps -a -o json 2>/dev/null \
    | grep -o 'sha256:[a-f0-9]\{64\}' \
    | sed 's/^sha256://' | cut -c1-13 | sort -u)"

# --- 2. Candidates: untagged images, optionally filtered to certain repos -----
# crictl columns: IMAGE(repo) TAG IMAGE-ID SIZE
all_untagged="$($CRICTL images 2>/dev/null | awk 'NR > 1 && $2 == "<none>" {print $3" "$1" "$4}')"

in_repo_filter() {
    [ -z "$PRUNE_REPOS" ] && return 0
    local repo="$1" pat
    for pat in $PRUNE_REPOS; do
        case "$repo" in *"$pat"*) return 0 ;; esac
    done
    return 1
}

candidates=""
while read -r id repo size; do
    [ -n "$id" ] || continue
    in_repo_filter "$repo" || continue
    candidates="${candidates}${id} ${repo} ${size}"$'\n'
done <<<"$all_untagged"

# Partition candidates into skip (in use) and delete.
todel="" skipped=""
while read -r id repo size; do
    [ -n "$id" ] || continue
    if printf '%s\n' "$inuse" | grep -qx "$id"; then
        skipped="${skipped}  ${repo} ${id}"$'\n'
    else
        todel="${todel}${id} ${repo} ${size}"$'\n'
    fi
done <<<"$candidates"

n_total="$($CRICTL images 2>/dev/null | tail -n +2 | grep -c . || true)"
n_cand="$(printf '%s' "$candidates" | grep -c . || true)"
n_del="$(printf '%s' "$todel" | grep -c . || true)"
n_skip="$(printf '%s' "$skipped" | grep -c . || true)"

echo "images on node:      ${n_total}"
echo "untagged candidates: ${n_cand}${PRUNE_REPOS:+ (filtered to: $PRUNE_REPOS)}"
echo "in use, skipped:     ${n_skip}"
echo "to delete:           ${n_del}"
echo "disk before:         ${pct_before} used"
echo "---"

if [ "$n_skip" -gt 0 ]; then
    echo "skipped (referenced by a container):"
    printf '%s' "$skipped"
    echo "---"
fi

if [ "$n_del" -eq 0 ]; then
    echo "nothing to prune"
    exit 0
fi

# --- 3. Prune ----------------------------------------------------------------
if [ "$PRUNE_DRY_RUN" = "yes" ]; then
    echo "DRY RUN — would delete:"
    printf '%s' "$todel" | awk '{printf "  %-45s %s %s\n", $2, $1, $3}'
    exit 0
fi

ok=0 fail=0
while read -r id repo size; do
    [ -n "$id" ] || continue
    if $CRICTL rmi "$id" >/dev/null 2>&1; then
        ok=$((ok + 1))
    else
        fail=$((fail + 1))
        echo "  FAILED ${repo} ${id}"
    fi
done <<<"$todel"

# --- 4. Report ---------------------------------------------------------------
used_after="$(df -B1 / | awk 'NR==2 {print $3}')"
pct_after="$(df -h / | awk 'NR==2 {print $5}')"
reclaimed=$(( used_before - used_after ))
[ "$reclaimed" -lt 0 ] && reclaimed=0

echo "deleted: ${ok}   failed: ${fail}"
echo "reclaimed: $(awk -v b="$reclaimed" 'BEGIN { printf "%.1fG", b / 1073741824 }')"
echo "disk: ${pct_before} -> ${pct_after} used"

# Nonzero only if the sweep genuinely broke. A clean run with nothing to do is
# success — this is maintenance, not a watchdog, so silence means healthy.
[ "$fail" -gt 0 ] && exit 1
exit 0

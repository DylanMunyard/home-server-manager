#!/usr/bin/env bash

# oom-check — alert on kernel OOM kills (and unclean reboots) since the last run
#
# Edge-triggered, not level-triggered: this reports things the kernel already
# killed, so it fires on the FIRST event instead of waiting for a memory
# percentage to stay bad. That distinction matters — a node being eaten alive
# spends most of each minute looking fine, because every OOM kill frees the
# memory that would have tripped a threshold. `node-health` watches the ramp;
# this watches the wreckage.
#
# The headline it exists to print is global vs cgroup-scoped:
#
#   GLOBAL  constraint=CONSTRAINT_NONE / global_oom — the killed container had
#           no memory limit, so the kernel picked a victim from the WHOLE node.
#           Collateral damage hits k3s, sshd, metrics-server, anything. This is
#           how one leaky pod takes down the box, and kubelet never even records
#           it as OOMKilled (the container just exits 255, reason "Unknown"), so
#           it is invisible from `kubectl get pods`.
#   CGROUP  the container hit its own limit and only it died. Working as intended.
#
# A missing state file means "first run" (or the node rebooted and wiped /tmp),
# so it looks back OOM_LOOKBACK_MINS rather than replaying all of history. Boot
# id is tracked in the same file: if it changed without the previous boot logging
# a clean shutdown, the node CRASHED, which is worth a page on its own.
# Zero-install: journalctl only, plus kubectl if it happens to be present.
#
# params:
#   OOM_LOOKBACK_MINS: { label: "First-run lookback (minutes)", default: "15" }
#   OOM_STATE_FILE:    { label: "On-node state file", default: "/tmp/oom-check.state" }
#   OOM_RESOLVE_PODS:  { label: "Resolve k8s pod UIDs to pod names", default: auto, choices: [auto, "no"] }

set -euo pipefail

state_file="$OOM_STATE_FILE"

# --- 0. Need journald; degrade harmlessly so a job can target any host --------
command -v journalctl >/dev/null 2>&1 || { echo "journalctl not available — skipping"; exit 0; }

boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"
now="$(date +%s)"

# --- 1. Watermark: resume where the last run stopped -------------------------
since=0 prev_boot=""
if [ -r "$state_file" ]; then
    read -r since prev_boot _ < "$state_file" 2>/dev/null || { since=0; prev_boot=""; }
    case "$since" in '' | *[!0-9]*) since=0 ;; esac
fi
first_run=0
if [ "$since" -eq 0 ]; then
    first_run=1
    since=$(( now - OOM_LOOKBACK_MINS * 60 ))
fi

write_state() { printf '%s %s\n' "$1" "$boot_id" > "$state_file" 2>/dev/null || true; }

# --- 2. Did the node reboot, and was it clean? -------------------------------
# `last -x` records an unclean shutdown as "crash" on the prior boot line. No
# state file at all is ambiguous (could be a fresh deploy), so only shout when
# we previously saw a DIFFERENT boot id.
rebooted=0 reboot_note=""
if [ -n "$prev_boot" ] && [ "$prev_boot" != "$boot_id" ]; then
    rebooted=1
    if last -x reboot shutdown 2>/dev/null | grep -q 'crash'; then
        reboot_note="node REBOOTED and the previous boot ended in a crash (no clean shutdown)"
    else
        reboot_note="node rebooted (previous boot shut down cleanly)"
    fi
fi

# --- 3. Collect OOM events since the watermark -------------------------------
# short-unix gives an epoch first field, which is both the watermark and a
# stable sort key. grep failures are non-fatal under pipefail via `|| true`.
#
# `_TRANSPORT=kernel`, NOT `-k`: the `-k` shorthand implies `-b`, restricting
# output to the CURRENT boot. An OOM spiral that ends in the node crashing would
# then report nothing on the next tick — silence exactly when it matters most.
log="$(journalctl _TRANSPORT=kernel --since "@${since}" -o short-unix --no-pager 2>/dev/null || true)"

# Three different lines describe one event, and they carry different fields:
#   "<task> invoked oom-killer"      — who tripped the allocation
#   "oom-kill:constraint=…"          — global_oom vs oom_memcg, and the cgroup
#                                      path holding the pod UID
#   "Out of memory: Killed process"  — the victim, its pid and anon-rss
# The kernel also emits the victim line twice (and sometimes once more for a
# sibling thread), so events are keyed by timestamp and deduped below.
kills="$(printf '%s\n' "$log" | grep 'Out of memory: Killed process' || true)"
scoping="$(printf '%s\n' "$log" | grep 'oom-kill:constraint=' || true)"

# Advance the watermark to the newest kernel line seen, so a quiet tick still
# moves forward and no kill is ever reported twice. `+0` forces a numeric
# compare — these are epoch strings and awk would otherwise compare them
# lexicographically.
newest="$(printf '%s\n' "$log" | awk 'NF { split($1, a, "."); if (a[1] + 0 > m + 0) m = a[1] } END { print m + 0 }')"
[ "${newest:-0}" -gt "$since" ] && since="$newest"
write_state "$since" "$boot_id"

# One event per second, not per log line.
kills="$(printf '%s\n' "$kills" | awk 'NF { ts = $1; sub(/\..*/, "", ts); if (!(ts in seen)) { seen[ts]; print } }')"
n_kills=$(printf '%s\n' "$kills" | grep -c . || true)

# --- 4. Report ---------------------------------------------------------------
if [ "$first_run" = 1 ]; then
    echo "first run — looked back ${OOM_LOOKBACK_MINS}m"
fi

if [ "$n_kills" -eq 0 ] && [ "$rebooted" -eq 0 ]; then
    echo "no OOM kills since last check"
    exit 0
fi

[ "$rebooted" -eq 1 ] && echo "$reboot_note"

if [ "$n_kills" -gt 0 ]; then
    # Global vs cgroup-scoped. Both live on the `oom-kill:constraint=` line.
    n_global=$(printf '%s\n' "$scoping" | grep -c 'global_oom' || true)
    n_memcg=$(printf '%s\n' "$scoping" | grep -c 'oom_memcg=' || true)

    echo "${n_kills} OOM event(s) since last check"
    [ "$n_global" -gt 0 ] && echo "  ${n_global} GLOBAL — victim container had no memory limit, so the kernel"
    [ "$n_global" -gt 0 ] && echo "            chose a victim from the whole node (collateral damage)"
    [ "$n_memcg" -gt 0 ]  && echo "  ${n_memcg} cgroup-scoped — container hit its own limit, contained"
    echo "---"

    # Victim table: time, process, RSS. anon-rss is the field that matters —
    # total-vm on .NET is meaningless (reserved address space, tens of GB).
    printf '%s\n' "$kills" | awk '
      {
        ts = $1; sub(/\..*/, "", ts)
        name = ""; rss = ""
        for (i = 1; i <= NF; i++) {
          if ($i ~ /^\(/)            { name = $i; gsub(/[()]/, "", name) }
          if ($i ~ /^anon-rss:/)     { rss = substr($i, 10) }
        }
        cmd = "date -d @" ts " +%H:%M:%S 2>/dev/null"
        cmd | getline hhmmss; close(cmd)
        if (rss != "") { sub(/kB$/, "", rss); rss = sprintf("%.0fMB", rss / 1024) }
        printf "  %s  killed %-18s rss=%s\n", (hhmmss ? hhmmss : ts), name, (rss ? rss : "?")
      }'

    # Which pod owned the victim? The cgroup path carries the pod UID; resolving
    # it to a name is the step that turns "a dotnet died" into "bf42-stats died".
    uids="$(printf '%s\n' "$scoping" \
        | grep -o 'pod[0-9a-f_]\{36\}' | sed 's/^pod//; s/_/-/g' | sort -u || true)"
    if [ -n "$uids" ] && [ "$OOM_RESOLVE_PODS" != "no" ] && command -v kubectl >/dev/null 2>&1; then
        echo "---"
        echo "owning pods:"
        map="$(kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.uid} {.metadata.namespace}/{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
        while read -r uid; do
            [ -n "$uid" ] || continue
            name="$(printf '%s\n' "$map" | awk -v u="$uid" '$1 == u { print $2; exit }')"
            echo "  ${name:-<gone> ($uid)}"
        done <<<"$uids"
    fi
fi

exit 1

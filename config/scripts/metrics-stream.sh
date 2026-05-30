#!/usr/bin/env bash
# metrics-stream — emit a live JSON metrics sample per interval (zero-install)
#
# Streams one compact JSON object per line (NDJSON) every METRICS_INTERVAL
# seconds, read straight from /proc + /sys + df — no packages, no sudo, no TTY.
# Run by the dashboard collector over `bash -s`; it loops forever and is killed
# (SIGTERM) when the collector tears the connection down. CPU% is the
# utilisation across each elapsed interval (delta of /proc/stat aggregate
# jiffies), so points line up with the sample cadence rather than being a
# single instantaneous guess. Hosts with no readable thermal sensors report
# "temp":null (safe to aim at any LXC/VM).
#
# params:
#   METRICS_INTERVAL: { label: "Sample interval (seconds)", default: "5" }
#   METRICS_MOUNTS:   { label: "Disk mounts (space-separated)", default: "/" }

set -euo pipefail

interval="${METRICS_INTERVAL:-5}"
read -r -a mounts <<< "${METRICS_MOUNTS:-/}"
ncpu="$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)"

# /proc/stat aggregate → "<total_jiffies> <idle_jiffies>" (idle includes iowait)
cpu_totals() {
    awk '/^cpu /{ idle=$5+$6; total=0; for (i=2;i<=NF;i++) total+=$i; print total, idle; exit }' /proc/stat
}

# Hottest temperature in whole °C across thermal zones + hwmon, or empty if none.
# Mirrors temp-check.sh's sysfs sweep; whole degrees are plenty for a dashboard.
hottest_temp() {
    local max=-1 f milli c
    for f in /sys/class/thermal/thermal_zone*/temp /sys/class/hwmon/*/temp*_input; do
        [ -r "$f" ] || continue
        milli="$(cat "$f" 2>/dev/null)" || continue
        case "$milli" in ''|*[!0-9-]*) continue ;; esac
        c=$(( milli / 1000 ))
        (( c <= 0 || c > 200 )) && continue
        if (( c > max )); then max="$c"; fi
    done
    # Emit nothing when no sensors are readable (cloud VM / LXC). Crucially this
    # must still return 0 — under `set -e` a bare `(( max >= 0 )) && echo` would
    # return 1 on a sensorless host and kill the whole script before any sample.
    if (( max >= 0 )); then echo "$max"; fi
    return 0
}

# JSON array of {mount,used,total} in GiB for each requested mount.
disk_json() {
    local out="" first=1 m line total used gib
    for m in "${mounts[@]}"; do
        line="$(df -P -B1 "$m" 2>/dev/null | awk 'NR==2{ print $2, $3 }')" || continue
        [ -z "$line" ] && continue
        # shellcheck disable=SC2086
        set -- $line
        total="$1"; used="$2"
        gib="$(awk -v t="$total" -v u="$used" 'BEGIN{ printf "%.1f %.1f", u/1073741824, t/1073741824 }')"
        # shellcheck disable=SC2086
        set -- $gib
        [ "$first" = 1 ] || out+=","
        first=0
        out+="{\"mount\":\"$m\",\"used\":$1,\"total\":$2}"
    done
    printf '[%s]' "$out"
}

read -r prev_total prev_idle < <(cpu_totals)

while true; do
    sleep "$interval"

    # CPU% across the interval just elapsed.
    read -r cur_total cur_idle < <(cpu_totals)
    cpu="$(awk -v pt="$prev_total" -v pi="$prev_idle" -v ct="$cur_total" -v ci="$cur_idle" \
        'BEGIN{ dt=ct-pt; di=ci-pi; if (dt<=0) print 0; else printf "%.1f", 100*(1-di/dt) }')"
    prev_total="$cur_total"; prev_idle="$cur_idle"

    # Memory (meminfo is kB) → MiB. "used" = total − available (the honest figure).
    read -r mem_total mem_avail < <(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{ print t, a }' /proc/meminfo)
    mem_used_mib=$(( (mem_total - mem_avail) / 1024 ))
    mem_total_mib=$(( mem_total / 1024 ))

    read -r l1 l5 l15 _ < /proc/loadavg

    temp="$(hottest_temp || true)"
    [ -z "$temp" ] && temp="null"

    printf '{"ts":%s,"cpu":%s,"ncpu":%s,"load":[%s,%s,%s],"mem":{"used":%s,"total":%s},"temp":%s,"disk":%s}\n' \
        "$(date +%s)" "$cpu" "$ncpu" "$l1" "$l5" "$l15" "$mem_used_mib" "$mem_total_mib" "$temp" "$(disk_json)"
done

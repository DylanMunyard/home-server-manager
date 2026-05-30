#!/usr/bin/env bash

# temp-check — alert when this host runs hot for a sustained period
#
# Reads every temperature the kernel exposes via sysfs (thermal zones + hwmon) —
# no packages required, no sudo, no TTY. Exits nonzero EXACTLY ONCE when the
# hottest reading has stayed at/above TEMP_THRESHOLD for at least TEMP_SUSTAIN
# seconds, then stays quiet until the host cools below
# (TEMP_THRESHOLD - TEMP_HYSTERESIS), which re-arms it for the next spike. The
# debounce lives here (not in the job engine) per the "engine stays dumb" rule;
# state is a tiny file on the target (TEMP_STATE_FILE), ephemeral by design.
# Targets with no readable sensors (LXC/VM) print a note and exit 0, so a job
# can be pointed at any host harmlessly.
#
# params:
#   TEMP_THRESHOLD:  { label: "Alert at/above (°C)", default: "80" }
#   TEMP_SUSTAIN:    { label: "Must stay hot for (seconds)", default: "300" }
#   TEMP_HYSTERESIS: { label: "Re-arm margin below threshold (°C)", default: "5" }
#   TEMP_STATE_FILE: { label: "On-node state file", default: "/tmp/temp-check.state" }

set -euo pipefail

threshold="$TEMP_THRESHOLD"
sustain="$TEMP_SUSTAIN"
hysteresis="$TEMP_HYSTERESIS"
state_file="$TEMP_STATE_FILE"

# --- 1. Collect readings (millidegrees → °C) from sysfs, zero-install --------
max=-1
max_label=""
readings=()

consider() {
    # $1 = millidegrees (integer), $2 = label
    local milli="$1" label="$2" c
    case "$milli" in
        ''|*[!0-9-]*) return ;;          # non-numeric → skip
    esac
    c=$(( milli / 1000 ))                 # whole °C is plenty for this
    (( c <= 0 || c > 200 )) && return     # implausible → skip (e.g. unused zones)
    readings+=("$label: ${c}°C")
    if (( c > max )); then max="$c"; max_label="$label"; fi
}

# thermal zones — universal on ARM (Pi) and present on most x86
for f in /sys/class/thermal/thermal_zone*/temp; do
    [ -r "$f" ] || continue
    type=""
    [ -r "${f%/temp}/type" ] && type="$(cat "${f%/temp}/type" 2>/dev/null)"
    consider "$(cat "$f" 2>/dev/null)" "${type:-$(basename "$(dirname "$f")")}"
done

# hwmon — x86 coretemp/k10temp, NVMe, board sensors, etc.
for f in /sys/class/hwmon/*/temp*_input; do
    [ -r "$f" ] || continue
    dir="$(dirname "$f")"
    label=""
    [ -r "${f%_input}_label" ] && label="$(cat "${f%_input}_label" 2>/dev/null)"
    [ -z "$label" ] && [ -r "$dir/name" ] && label="$(cat "$dir/name" 2>/dev/null)"
    consider "$(cat "$f" 2>/dev/null)" "${label:-$(basename "$f")}"
done

# --- 2. No sensors → no-op (safe to aim a job at any target) -----------------
if (( max < 0 )); then
    echo "no temperature sensors found"
    exit 0
fi

# --- 3. Always report (lands in the ntfy body + job lastCheck stdout) --------
printf '%s\n' "${readings[@]}"
echo "---"
echo "hottest: ${max_label} ${max}°C (threshold ${threshold}°C)"

# --- 4. Sustain + once-only state machine -----------------------------------
now="$(date +%s)"
state="cool"
firsthot=0
if [ -r "$state_file" ]; then
    read -r state firsthot _ < "$state_file" 2>/dev/null || { state="cool"; firsthot=0; }
    [ -z "${state:-}" ] && state="cool"
    case "$firsthot" in ''|*[!0-9]*) firsthot=0 ;; esac
fi

write_state() { printf '%s %s\n' "$1" "$2" > "$state_file" 2>/dev/null || true; }

if (( max < threshold - hysteresis )); then
    # Cooled past the hysteresis band → re-arm for the next spike.
    write_state cool 0
    exit 0
fi

if (( max < threshold )); then
    # In the hysteresis band: not hot enough to start/continue, not cool enough
    # to re-arm. Hold whatever state we had.
    exit 0
fi

# max >= threshold from here.
if [ "$state" = "alerted" ]; then
    # Already alerted this hot spell — stay silent until it cools and re-arms.
    exit 0
fi

# cool/pending/missing while hot: (re)start the timer on the first hot tick,
# then alert the moment we've been hot for `sustain` seconds.
[ "$state" = "pending" ] || firsthot="$now"
if (( now - firsthot >= sustain )); then
    write_state alerted "$firsthot"
    echo "sustained ≥ ${sustain}s at/above ${threshold}°C — alerting"
    exit 1                               # the single nonzero tick → ntfy alert
fi
write_state pending "$firsthot"
echo "hot for $(( now - firsthot ))s (alert at ${sustain}s)"
exit 0

#!/usr/bin/env bash

# node-health — alert when CPU, memory, or website latency stays bad
#
# Three independent signals, each with its own consecutive-breach counter:
#   cpu — busy CPU in CORES (not %), sampled from /proc/stat over a few seconds,
#         so "above 3" means more than three cores' worth of work
#   mem — used % of MemTotal (MemAvailable-based, so page cache doesn't count)
#   web — wall time for a GET of WEB_URL (skipped when WEB_URL is empty);
#         an unreachable site counts as a breach too
#
# A signal must breach on BREACH_COUNT *consecutive* runs (job ticks) before
# this exits nonzero — and it does so EXACTLY ONCE per incident, staying quiet
# until that signal recovers (one healthy run re-arms it). The debounce lives
# here, not in the job engine, per the "engine stays dumb" rule (same pattern
# as temp-check); state is a tiny file on the target, ephemeral by design.
# Every run prints the readings + per-signal breach progress, so the job's
# lastCheck and the alert body always say WHY. Zero-install: /proc + df-free,
# needs curl only when WEB_URL is set.
#
# params:
#   CPU_MAX_CORES:   { label: "Alert when busy CPU exceeds (cores)", default: "3" }
#   MEM_MAX_PCT:     { label: "Alert when memory used exceeds (%)", default: "85" }
#   WEB_URL:         { label: "URL to probe (empty = skip)", default: "" }
#   WEB_MAX_SECS:    { label: "Alert when the URL takes longer than (s)", default: "2" }
#   BREACH_COUNT:    { label: "Consecutive bad runs before alerting", default: "5" }
#   CPU_SAMPLE_SECS: { label: "CPU sampling window (seconds)", default: "3" }
#   STATE_FILE:      { label: "On-node state file", default: "/tmp/node-health.state" }

set -euo pipefail

# --- 1. Take the readings -----------------------------------------------------

# /proc/stat cpu line: user nice system idle iowait irq softirq steal.
# busy = everything except idle+iowait; two samples → cores of work in between.
read_stat() { awk '/^cpu / { print $2+$3+$4+$7+$8+$9, $2+$3+$4+$5+$6+$7+$8+$9 }' /proc/stat; }
read -r busy1 total1 < <(read_stat)
sleep "$CPU_SAMPLE_SECS"
read -r busy2 total2 < <(read_stat)
cpu_cores=$(awk -v b="$((busy2 - busy1))" -v t="$((total2 - total1))" -v n="$(nproc)" \
  'BEGIN { printf "%.2f", (t > 0 ? b / t * n : 0) }')

mem_pct=$(awk '/^MemTotal:/ { t=$2 } /^MemAvailable:/ { a=$2 } END { printf "%.0f", (t - a) / t * 100 }' /proc/meminfo)

web_state="skipped" web_secs=""
if [ -n "$WEB_URL" ]; then
  if web_secs=$(curl -fsSL -o /dev/null --max-time 10 -w '%{time_total}' "$WEB_URL" 2>/dev/null); then
    web_state="ok"
  else
    web_state="unreachable"
  fi
fi

echo "cpu: ${cpu_cores} cores busy (max ${CPU_MAX_CORES})"
echo "mem: ${mem_pct}% used (max ${MEM_MAX_PCT}%)"
case "$web_state" in
  skipped)     echo "web: skipped (no WEB_URL)" ;;
  ok)          echo "web: ${WEB_URL} in ${web_secs}s (max ${WEB_MAX_SECS}s)" ;;
  unreachable) echo "web: ${WEB_URL} UNREACHABLE" ;;
esac
echo "---"

# --- 2. Per-signal consecutive-count state machine ----------------------------
# State file: one "<signal> <count> <alerted>" line per signal.
declare -A count alerted
for s in cpu mem web; do count[$s]=0; alerted[$s]=0; done
if [ -r "$STATE_FILE" ]; then
  while read -r s c a _; do
    case "$s" in cpu|mem|web) ;; *) continue ;; esac
    case "$c" in '' | *[!0-9]*) c=0 ;; esac
    count[$s]="$c"
    [ "${a:-0}" = 1 ] && alerted[$s]=1
  done < "$STATE_FILE"
fi

over() { awk -v v="$1" -v m="$2" 'BEGIN { exit !(v > m) }'; }

alerts=()
exit_code=0

# tick <signal> <breached 0|1> <detail>
tick() {
  local sig="$1" breached="$2" detail="$3"
  if [ "$breached" = 1 ]; then
    count[$sig]=$(( count[$sig] + 1 ))
    if [ "${alerted[$sig]}" = 1 ]; then
      echo "$sig: $detail — still bad (already alerted this incident)"
    elif (( count[$sig] >= BREACH_COUNT )); then
      alerted[$sig]=1
      alerts+=("$sig: $detail for ${count[$sig]} consecutive runs")
      exit_code=1
    else
      echo "$sig: $detail — bad run ${count[$sig]}/${BREACH_COUNT}"
    fi
  else
    [ "${alerted[$sig]}" = 1 ] && echo "$sig: recovered — re-armed"
    count[$sig]=0
    alerted[$sig]=0
  fi
}

cpu_breach=0; over "$cpu_cores" "$CPU_MAX_CORES" && cpu_breach=1
tick cpu "$cpu_breach" "${cpu_cores} cores busy (> ${CPU_MAX_CORES})"

mem_breach=0; over "$mem_pct" "$MEM_MAX_PCT" && mem_breach=1
tick mem "$mem_breach" "${mem_pct}% used (> ${MEM_MAX_PCT}%)"

if [ "$web_state" != "skipped" ]; then
  web_breach=0
  if [ "$web_state" = "unreachable" ]; then
    web_breach=1
    tick web "$web_breach" "${WEB_URL} unreachable"
  else
    over "$web_secs" "$WEB_MAX_SECS" && web_breach=1
    tick web "$web_breach" "${web_secs}s response (> ${WEB_MAX_SECS}s)"
  fi
fi

{ for s in cpu mem web; do printf '%s %s %s\n' "$s" "${count[$s]}" "${alerted[$s]}"; done; } \
  > "$STATE_FILE" 2>/dev/null || true

# --- 3. Signal -----------------------------------------------------------------
if (( exit_code != 0 )); then
  printf 'ALERT %s\n' "${alerts[@]}"
  exit 1
fi
echo "ok"
exit 0

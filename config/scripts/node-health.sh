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
# A signal alerts when EITHER of two conditions holds, and does so EXACTLY ONCE
# per incident:
#   consecutive — BREACH_COUNT runs in a row are bad (the classic sustained case)
#   bursty      — WINDOW_BREACHES of the last WINDOW_SIZE runs are bad, even
#                 though never consecutively (only for signals in WINDOW_SIGNALS)
#
# The window exists because consecutive-only counting has a blind spot that is
# not hypothetical: it missed the August 2026 bfstats incident entirely. A node
# being eaten by an unbounded process looks FINE most of the time, because every
# OOM kill frees the memory that would have tripped the threshold. The ramp
# breaches, the kill resets it to healthy, the counter re-arms, and the cycle
# repeats — twelve times over eight hours without a single alert. Pair this with
# the `oom-check` runbook, which catches the kills themselves.
#
# WINDOW_SIGNALS deliberately EXCLUDES cpu by default. The window suits a signal
# that ratchets — memory climbing toward a ceiling, a site degrading — where
# "briefly fine" is an artifact of the failure, not real recovery. CPU is the
# opposite: a stats collector is *supposed* to burst to a couple of cores and
# fall back to idle, and counting those bursts across a window would alert on
# healthy behaviour. CPU keeps the consecutive rule, which only fires when the
# box is genuinely saturated for BREACH_COUNT runs straight.
#
# Recovery for a windowed signal requires a CLEAN WINDOW, not one good run, so a
# flapping signal cannot silently re-arm between bursts; non-windowed signals
# re-arm on the first healthy run as before. The debounce lives here, not in the
# job engine, per the "engine stays dumb" rule (same pattern as temp-check);
# state is a tiny file on the target, ephemeral by design. Every run prints the
# readings + per-signal progress, and a breaching signal names the top offending
# processes, so the job's lastCheck and the alert body always say WHY and WHO.
# Zero-install: /proc + df-free, needs curl only when WEB_URL is set.
#
# params:
#   CPU_MAX_CORES:   { label: "Alert when busy CPU exceeds (cores)", default: "3" }
#   MEM_MAX_PCT:     { label: "Alert when memory used exceeds (%)", default: "85" }
#   WEB_URL:         { label: "URL to probe (empty = skip)", default: "" }
#   WEB_MAX_SECS:    { label: "Alert when the URL takes longer than (s)", default: "2" }
#   BREACH_COUNT:    { label: "Consecutive bad runs before alerting", default: "5" }
#   WINDOW_SIZE:     { label: "Sliding window length (runs)", default: "15" }
#   WINDOW_BREACHES: { label: "Bad runs within the window before alerting", default: "8" }
#   WINDOW_SIGNALS:  { label: "Signals using the bursty window (space-separated)", default: "mem web" }
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

over() { awk -v v="$1" -v m="$2" 'BEGIN { exit !(v > m) }'; }

cpu_breach=0; over "$cpu_cores" "$CPU_MAX_CORES" && cpu_breach=1
mem_breach=0; over "$mem_pct"   "$MEM_MAX_PCT"   && mem_breach=1

# Name the top three offenders on a breach. "mem 92%" sends you looking; "mem
# 92% — dotnet 2384MB" is already the answer. `ps` and its pipeline are excluded
# because they are freshly spawned and ps reports CPU as a LIFETIME average —
# the measuring process otherwise reports itself at ~100% and tops the list.
top3() { ps -eo "$1",comm --sort=-"$1" 2>/dev/null | awk -v u="$2" '
  NR > 1 && $2 != "ps" && $2 != "awk" && n < 3 {
    printf "%s%s %.0f%s", (n++ ? ", " : ""), $2, (u == "MB" ? $1 / 1024 : $1), u
  }
  END { print "" }'; }

echo "cpu: ${cpu_cores} cores busy (max ${CPU_MAX_CORES})"
[ "$cpu_breach" = 1 ] && echo "     top: $(top3 pcpu '%')"
echo "mem: ${mem_pct}% used (max ${MEM_MAX_PCT}%)"
[ "$mem_breach" = 1 ] && echo "     top: $(top3 rss 'MB')"
case "$web_state" in
  skipped)     echo "web: skipped (no WEB_URL)" ;;
  ok)          echo "web: ${WEB_URL} in ${web_secs}s (max ${WEB_MAX_SECS}s)" ;;
  unreachable) echo "web: ${WEB_URL} UNREACHABLE" ;;
esac
echo "---"

# --- 2. Per-signal state machine: consecutive count + sliding window ----------
# State file: one "<signal> <count> <alerted> <history>" line per signal, where
# history is a string of 0/1 verdicts, oldest first, capped at WINDOW_SIZE.
declare -A count alerted hist
for s in cpu mem web; do count[$s]=0; alerted[$s]=0; hist[$s]=""; done
if [ -r "$STATE_FILE" ]; then
  while read -r s c a h; do
    case "$s" in cpu|mem|web) ;; *) continue ;; esac
    case "$c" in '' | *[!0-9]*) c=0 ;; esac
    case "$h" in *[!01]*) h="" ;; esac
    count[$s]="$c"
    hist[$s]="$h"
    [ "${a:-0}" = 1 ] && alerted[$s]=1
  done < "$STATE_FILE"
fi

alerts=()
exit_code=0

# tick <signal> <breached 0|1> <detail>
tick() {
  local sig="$1" breached="$2" detail="$3"

  # Does this signal use the bursty window, or consecutive-only? (cpu is
  # excluded by default — see the header.)
  local windowed=0
  case " $WINDOW_SIGNALS " in *" $sig "*) windowed=1 ;; esac

  # Record this run's verdict, keeping only the last WINDOW_SIZE.
  hist[$sig]="${hist[$sig]}${breached}"
  (( ${#hist[$sig]} > WINDOW_SIZE )) && hist[$sig]="${hist[$sig]: -WINDOW_SIZE}"
  local ones="${hist[$sig]//0/}"
  local wbad=${#ones} wlen=${#hist[$sig]}

  if [ "$breached" = 1 ]; then
    count[$sig]=$(( count[$sig] + 1 ))
    if [ "${alerted[$sig]}" = 1 ]; then
      echo "$sig: $detail — still bad (already alerted this incident)"
    elif (( count[$sig] >= BREACH_COUNT )); then
      alerted[$sig]=1
      alerts+=("$sig: $detail for ${count[$sig]} consecutive runs")
      exit_code=1
    elif (( windowed && wbad >= WINDOW_BREACHES )); then
      alerted[$sig]=1
      alerts+=("$sig: $detail — ${wbad} bad runs out of the last ${wlen} (bursty, never consecutive)")
      exit_code=1
    elif (( windowed )); then
      echo "$sig: $detail — bad run ${count[$sig]}/${BREACH_COUNT}, window ${wbad}/${WINDOW_BREACHES}"
    else
      echo "$sig: $detail — bad run ${count[$sig]}/${BREACH_COUNT}"
    fi
  else
    count[$sig]=0
    # A windowed signal re-arms only once the WHOLE window is clean: one good
    # run is not recovery when the failure mode is bursty, and that is precisely
    # how a flapping signal stays silent forever. A non-windowed signal (cpu)
    # re-arms immediately — bursting back to idle really is recovery there.
    if [ "${alerted[$sig]}" = 1 ]; then
      if (( !windowed || wbad == 0 )); then
        echo "$sig: recovered — re-armed"
        alerted[$sig]=0
      else
        echo "$sig: ok this run, but ${wbad}/${wlen} still bad in window — holding"
      fi
    fi
  fi
}

tick cpu "$cpu_breach" "${cpu_cores} cores busy (> ${CPU_MAX_CORES})"
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

{ for s in cpu mem web; do
    printf '%s %s %s %s\n' "$s" "${count[$s]}" "${alerted[$s]}" "${hist[$s]:-0}"
  done; } > "$STATE_FILE" 2>/dev/null || true

# --- 3. Signal -----------------------------------------------------------------
if (( exit_code != 0 )); then
  printf 'ALERT %s\n' "${alerts[@]}"
  exit 1
fi
echo "ok"
exit 0

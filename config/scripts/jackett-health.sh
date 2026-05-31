#!/usr/bin/env bash
# jackett-health — flag any configured Jackett indexer that fails a live search
#
# Uses Jackett's apikey-authenticated Torznab API only — no admin password. Lists
# configured indexers via `t=indexers&configured=true`, then runs a real
# `t=search` against each and flags any that come back as a Torznab <error>
# instead of an <rss> feed — catching expired logins, Cloudflare walls, rate-
# limits, or a dead tracker. (Jackett's indexer-management + self-test endpoints
# are gated by the admin-login cookie, NOT the apikey, so this takes the Torznab
# door instead.) Pair it with an alert-only job (no when/then, notify on error)
# for an ntfy ping the moment an indexer goes red. Read-only: only GET searches,
# never changes config. Needs `curl` on the target and a reachable Jackett.
#
# Jackett returns Torznab errors as HTTP 200 with an <error code=.. description=..>
# body, so health keys off the response body, not the status code.
#
# The apikey is a secret. Job runs get it from the job's `env:` (JACKETT_APIKEY,
# resolved from .env). Manual UI runs have no job env, so they fall back to the
# JACKETT_APIKEY_MANUAL param you type in. The two names differ ON PURPOSE: a
# same-named param would inject an empty value *after* the job env and clobber
# the real key (params inject last and win). URL + probe query are plain params.
#
# params:
#   JACKETT_URL:           { label: "Jackett base URL", default: "http://127.0.0.1:9117" }
#   JACKETT_QUERY:         { label: "Probe search term", default: "ubuntu" }
#   JACKETT_APIKEY_MANUAL: { label: "API key (manual runs only — jobs read .env)" }

set -euo pipefail

base="${JACKETT_URL%/}"
query="${JACKETT_QUERY:-ubuntu}"
# Prefer the job env secret; fall back to the manual-run param (see header).
key="${JACKETT_APIKEY:-${JACKETT_APIKEY_MANUAL:-}}"

if [ -z "$key" ]; then
  echo "no API key — set JACKETT_APIKEY in .env (for the job) or fill the API key field (manual run)" >&2
  exit 2
fi

tz="$base/api/v2.0/indexers"
# Match in-process (bash), never `printf "$big_body" | grep` — with pipefail a
# grep that matches near the start of a large feed closes the pipe early, printf
# takes SIGPIPE, and the pipeline reports failure (false negative). always-0.
desc_of() { [[ $1 =~ description=\"([^\"]*)\" ]] && printf '%s' "${BASH_REMATCH[1]}"; return 0; }

# 1. Enumerate configured indexers via the apikey-only Torznab endpoint.
list="$(curl -fsS --max-time 20 "$tz/all/results/torznab/api?apikey=$key&t=indexers&configured=true")" || {
  echo "cannot reach Jackett at $base (is it up?)" >&2
  exit 2
}

# A bad/expired key (or other global failure) comes back as a single <error>.
if [[ $list == *'<error '* ]]; then
  echo "Jackett rejected the indexer list: $(desc_of "$list")" >&2
  exit 2
fi

mapfile -t ids < <(printf '%s' "$list" | grep -oE '<indexer id="[^"]+"' | sed -E 's/.*id="([^"]+)"/\1/')
total=${#ids[@]}
if (( total == 0 )); then
  echo "no configured indexers found"
  exit 0
fi

# 2. Live-search each indexer; an <error> body (not an <rss> feed) = unhealthy.
#    This actually queries the tracker, so it's the slow part — keep the job
#    schedule gentle (hourly is plenty) to avoid hammering the trackers.
failed=()
for id in "${ids[@]}"; do
  body="$(curl -sS --max-time 45 "$tz/$id/results/torznab/api?apikey=$key&t=search&q=$query" 2>/dev/null || true)"
  if [[ $body == *'<error '* ]]; then
    reason="$(desc_of "$body")"
    echo "FAIL  $id — ${reason:-torznab error}"
    failed+=("$id: ${reason:-error}")
  elif [[ $body == *'<rss'* ]]; then
    echo "OK    $id"
  else
    echo "FAIL  $id — no feed returned (timeout or empty response)"
    failed+=("$id: no feed")
  fi
done

# 3. Summary + signal. The summary lands in the ntfy body and the job's
#    lastCheck stdout, so a phone alert names exactly which indexers are red.
echo "---"
echo "$(( total - ${#failed[@]} ))/$total indexers healthy"
if (( ${#failed[@]} > 0 )); then
  printf 'unhealthy: %s\n' "${failed[@]}"
  exit 1
fi
exit 0

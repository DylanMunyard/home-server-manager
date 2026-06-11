#!/usr/bin/env bash
# vpn-check — exit nonzero when the box is off the PIA VPN (or has no internet)
#
# Detection keys on the egress ISP, not a fixed IP: when the WireGuard tunnel
# drops, traffic exits via the home uplink and ip-api reports the home ISP.
# Matching the ISP/AS string is robust to the home IP changing (it's dynamic)
# and works the same whether run by the job or by hand. Override the match via
# VPN_HOME_ISP (set it in .env + the job's `env:` block to keep it out of git).
# Requires `jq` and `curl` on the target.
# nodes: [ bethany/linux-isos ]
set -euo pipefail

HOME_ISP="${VPN_HOME_ISP:-Vocus}"

info="$(curl -s --max-time 10 http://ip-api.com/json)" || {
  echo "no internet connectivity (curl failed)"
  exit 1
}
echo "$info"

status="$(printf '%s' "$info" | jq -r '.status')"
if [ "$status" != "success" ]; then
  echo "ip-api lookup inconclusive (status=$status) — leaving VPN state unchanged"
  exit 0
fi

ip="$(printf '%s' "$info" | jq -r '.query')"
sig="$(printf '%s' "$info" | jq -r '(.isp // "") + " " + (.as // "")')"

# Home ISP on the egress = tunnel is down / never came up.
if printf '%s' "$sig" | grep -qiF "$HOME_ISP"; then
  echo "off-VPN: egress via home ISP \"$HOME_ISP\" (ip $ip)"
  exit 1
fi

echo "on VPN (egress ip $ip — isp does not match \"$HOME_ISP\")"
exit 0

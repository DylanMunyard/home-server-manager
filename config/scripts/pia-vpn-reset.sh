#!/usr/bin/env bash
# pia-vpn-reset — regen wireguard + restart tunnel
# nodes: [ bethany/linux-isos ]
set -euo pipefail

systemctl stop wg-quick@wg0.service

cd pia-wg
source venv/bin/activate
python3 generate-config.py

sudo cp PIA-wg.conf /etc/wireguard/wg0.conf
systemctl restart wg-quick@wg0.service

curl -s http://ip-api.com/json

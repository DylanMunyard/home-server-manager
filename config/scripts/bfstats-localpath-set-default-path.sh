#!/usr/bin/env bash
# bfstats-localpath-set-default-path — point k3s's local-path provisioner at the
#     attached volume, so NEW PVCs provision there instead of the root disk
#
# WHAT THIS CHANGES
#   The `local-path-config` ConfigMap's nodePathMap, replacing the root-disk path
#   with MOUNT_PATH. Plus a `local-storage.yaml.skip` marker so k3s stops
#   re-applying its packaged copy and reverting us on the next restart/upgrade.
#
# WHAT THIS DOES NOT CHANGE
#   Existing PersistentVolumes. A PV records its directory in `spec.local.path`
#   at creation time; that value is immutable and the provisioner never revisits
#   it. nodePathMap is consulted ONLY when provisioning a brand-new PV. Nothing
#   here can move, re-path or re-provision data that already exists. The script
#   prints every PV path before and after so you can see that for yourself.
#
#   The path is REPLACED, not appended. When nodePathMap lists multiple paths the
#   provisioner picks one AT RANDOM per volume unless a StorageClass pins it with
#   `nodePath` — so appending would make new PVCs land unpredictably on either
#   disk. One path in, one path out.
#
# TRADE-OFF YOU ARE ACCEPTING
#   The .skip marker means k3s no longer manages local-storage.yaml at all — the
#   provisioner Deployment, RBAC and ConfigMap become yours to maintain across
#   k3s upgrades. Future k3s versions shipping a newer provisioner will not
#   upgrade it for you. REVERT=1 hands it back.
#
# params:
#   MOUNT_PATH: { label: "Host path new PVCs should provision onto", default: "/mnt/bfstats-data" }
#   REVERT:     { label: "Set to 1 to restore k3s's default and remove the .skip", default: "0" }
#   RESTART_K3S: { label: "Set to 1 to bounce k3s afterwards to prove the change survives", default: "0" }
# nodes: [ hetzner/bfstats ]
# confirm: This edits the cluster's local-path provisioner configuration so NEW PVCs provision onto the attached volume. Existing PVs and their data are untouched. Continue?
#
# Exit codes: 0 applied and verified · 1 verification failed · 2 prerequisite missing

set -euo pipefail

MOUNT_PATH="${MOUNT_PATH:-/mnt/bfstats-data}"
REVERT="${REVERT:-0}"
RESTART_K3S="${RESTART_K3S:-0}"

MANIFEST=/var/lib/rancher/k3s/server/manifests/local-storage.yaml
SKIP="${MANIFEST}.skip"
BACKUP_DIR=/root/local-path-config-backups

log() { printf '==> %s\n' "$*" >&2; }
dim() { printf '    %s\n' "$*" >&2; }
die() { printf '[fail] %s\n' "$*" >&2; exit "${2:-1}"; }

command -v kubectl >/dev/null 2>&1 || die "kubectl not installed on host" 2
[ -f "$MANIFEST" ] || die "k3s packaged manifest not found at $MANIFEST" 2

show_pvs() {
  kubectl get pv -o custom-columns='PV:.metadata.name,CLAIM:.spec.claimRef.name,PATH:.spec.local.path,RECLAIM:.spec.persistentVolumeReclaimPolicy' 2>/dev/null \
    || echo "(no PVs)"
}

current_path() {
  kubectl -n kube-system get cm local-path-config -o jsonpath='{.data.config\.json}' 2>/dev/null \
    | tr -d ' \n' | sed -n 's/.*"paths":\[\([^]]*\)\].*/\1/p'
}

mkdir -p "$BACKUP_DIR"

# ── revert ───────────────────────────────────────────────────────────────────
if [ "$REVERT" = "1" ]; then
  log "REVERT — handing local-storage.yaml back to k3s"
  rm -f "$SKIP" && dim "removed $SKIP"
  kubectl apply -f "$MANIFEST" >&2
  log "Restarting provisioner"
  kubectl -n kube-system rollout restart deployment/local-path-provisioner >&2
  kubectl -n kube-system rollout status deployment/local-path-provisioner --timeout=120s >&2
  dim "paths now: $(current_path)"
  log "Reverted. Existing PVs (unchanged throughout):"
  show_pvs >&2
  exit 0
fi

# ── preflight ────────────────────────────────────────────────────────────────
log "Preflight"

mountpoint -q "$MOUNT_PATH" \
  || die "$MOUNT_PATH is not a mount point — refusing to point the provisioner at a plain directory on the root disk"
dim "$MOUNT_PATH is a mount point"

dev_vol="$(stat -c %d "$MOUNT_PATH")"
dev_root="$(stat -c %d /var/lib/rancher/k3s/storage)"
[ "$dev_vol" != "$dev_root" ] \
  || die "$MOUNT_PATH is on the same device as the root storage path — the volume is not really mounted"
dim "confirmed separate device from the root disk"
dim "$(df -h --output=source,size,avail,target "$MOUNT_PATH" | tail -1)"

echo >&2
log "PVs BEFORE (these must be identical afterwards)"
show_pvs >&2
before="$(show_pvs)"
echo >&2

# ── back up what we are about to change ──────────────────────────────────────
stamp="$(date +%Y%m%d-%H%M%S)"
kubectl -n kube-system get cm local-path-config -o yaml > "$BACKUP_DIR/local-path-config-$stamp.yaml"
log "Backed up current ConfigMap"
dim "$BACKUP_DIR/local-path-config-$stamp.yaml"
dim "current paths: $(current_path)"

# ── stop k3s re-applying its packaged copy ───────────────────────────────────
log "Marking local-storage.yaml as skipped so k3s stops reverting it"
touch "$SKIP"
dim "created $SKIP"

# ── patch the ConfigMap ──────────────────────────────────────────────────────
# Only config.json changes. setup/teardown/helperPod are left exactly as k3s
# shipped them — in particular the teardown `rm -rf "${VOL_DIR}"`, which is why
# PV reclaim policy matters so much elsewhere in this migration.
log "Setting nodePathMap to [$MOUNT_PATH]"
NEW_CONFIG=$(cat <<JSON
{
  "nodePathMap":[
  {
    "node":"DEFAULT_PATH_FOR_NON_LISTED_NODES",
    "paths":["$MOUNT_PATH"]
  }
  ]
}
JSON
)
kubectl -n kube-system patch cm local-path-config \
  --type merge \
  -p "$(printf '{"data":{"config.json":%s}}' "$(printf '%s' "$NEW_CONFIG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" >&2

# ── restart the provisioner so it definitely re-reads config ─────────────────
log "Restarting local-path-provisioner"
kubectl -n kube-system rollout restart deployment/local-path-provisioner >&2
kubectl -n kube-system rollout status deployment/local-path-provisioner --timeout=120s >&2

# ── verify ───────────────────────────────────────────────────────────────────
echo >&2
log "Verification"
now="$(current_path)"
dim "configured paths: $now"
case "$now" in
  *"$MOUNT_PATH"*) dim "OK: provisioner configured for $MOUNT_PATH" ;;
  *) die "ConfigMap does not contain $MOUNT_PATH after patching (got: $now)" ;;
esac
case "$now" in
  *"/var/lib/rancher/k3s/storage"*)
    die "root-disk path is STILL present — new PVCs would land randomly on either disk" ;;
esac
dim "OK: root-disk path removed, no random path selection"

echo >&2
log "PVs AFTER"
show_pvs >&2
after="$(show_pvs)"

if [ "$before" = "$after" ]; then
  dim "OK: existing PVs byte-for-byte unchanged"
else
  die "existing PVs CHANGED — this should be impossible; investigate before proceeding"
fi

# ── optional: prove it survives a k3s restart ────────────────────────────────
if [ "$RESTART_K3S" = "1" ]; then
  echo >&2
  log "Restarting k3s to prove the .skip marker holds"
  systemctl restart k3s
  sleep 20
  deadline=$((SECONDS + 180))
  until kubectl get --raw /readyz >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || die "k3s did not become ready after restart"
    sleep 5
  done
  dim "k3s ready"
  post="$(current_path)"
  dim "paths after k3s restart: $post"
  case "$post" in
    *"$MOUNT_PATH"*) dim "OK: change survived the k3s restart" ;;
    *) die "k3s reverted the ConfigMap — the .skip marker did not work" ;;
  esac
fi

echo >&2
log "DONE — new PVCs will provision onto $MOUNT_PATH"
dim "Existing PVs and their data are untouched."
dim "Revert with: REVERT=1 $(basename "$0")"

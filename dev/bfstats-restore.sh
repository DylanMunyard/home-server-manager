#!/usr/bin/env bash
# bfstats-restore — pull the SQLite + Neo4j databases out of a Hetzner backup
#                   without touching production.
#
# Clones the chosen backup image into a throwaway server and boots it into the
# RESCUE system, so the restored image never executes a single service — k3s
# and the bf42-stats app are never started, and cannot race us to the database.
# The clone's disk is mounted read-write, the SQLite WAL is checkpointed in
# place with sqlite3 running on the box, both databases are gzipped there, and
# the archives are streamed down over SSH. The clone is destroyed on exit.
#
# Production (bfstats-arm64, id 120554634) is never contacted, scaled, rebuilt
# or modified. The only writes happen to the throwaway clone's disk.
#
# Env params (all optional — job-engine friendly, no flags, never prompts):
#   BACKUP_IMAGE_ID   backup image to restore        (default: newest)
#   RESTORE_WHAT      sqlite | neo4j | both          (default: both)
#   DEST_DIR          where archives land            (default: <bfstats>/.restore)
#   SERVER_TYPE       clone server type              (default: cax21)
#   LOCATION          clone location                 (default: hel1)
#   SSH_KEY_FILE      private key for rescue         (default: ~/.ssh/hetzner)
#   SSH_KEY_NAME      project key to inject          (default: hetzner bfstats sshkey)
#   HCLOUD_BIN        hcloud binary                  (default: repo clone, then PATH)
#   HCLOUD_CONTEXT    hcloud context                 (default: bfstats)
#   KEEP_CLONE        1 = don't delete (debugging)   (default: 0)
#
# Exit codes: 0 ok · 1 runtime failure · 2 missing prerequisite · 3 bad config

set -euo pipefail

# ── config ───────────────────────────────────────────────────────────────────

BFSTATS_REPO="${BFSTATS_REPO:-$HOME/projects/skandia/bfstats}"

BACKUP_IMAGE_ID="${BACKUP_IMAGE_ID:-}"
RESTORE_WHAT="${RESTORE_WHAT:-both}"
DEST_DIR="${DEST_DIR:-$BFSTATS_REPO/.restore}"
SERVER_TYPE="${SERVER_TYPE:-cax21}"
LOCATION="${LOCATION:-hel1}"
SSH_KEY_FILE="${SSH_KEY_FILE:-$HOME/.ssh/hetzner}"
SSH_KEY_NAME="${SSH_KEY_NAME:-hetzner bfstats sshkey}"
HCLOUD_CONTEXT="${HCLOUD_CONTEXT:-bfstats}"
KEEP_CLONE="${KEEP_CLONE:-0}"

# The production server. Hard-coded as a guard: the cleanup path refuses to
# delete this id no matter what else goes wrong.
PROD_SERVER_ID=120554634
PROD_SERVER_NAME="bfstats-arm64"

# Every clone this script makes is named with this prefix. Cleanup refuses to
# touch anything that doesn't match, so a bug can't delete a real server.
CLONE_PREFIX="bfstats-restore-"

# Where the app's PVCs live on the restored disk, relative to the mount point.
K3S_STORAGE="var/lib/rancher/k3s/storage"
SQLITE_FILENAME="playertracker.db"

MOUNT_POINT="/mnt/target"

# ── plumbing ─────────────────────────────────────────────────────────────────

if [ -t 2 ]; then
  C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_OFF=$'\033[0m'
else
  C_DIM=""; C_RED=""; C_GRN=""; C_YEL=""; C_OFF=""
fi

log()  { printf '%s==>%s %s\n' "$C_GRN" "$C_OFF" "$*" >&2; }
warn() { printf '%s[warn]%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
dim()  { printf '%s    %s%s\n'   "$C_DIM" "$*" "$C_OFF" >&2; }
die()  { local rc=$1; shift; printf '%s[fail]%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit "$rc"; }

# Resolve the hcloud binary: explicit override, then the local clone, then PATH.
if [ -n "${HCLOUD_BIN:-}" ]; then
  :
elif [ -x "$HOME/projects/public/hetzner-cli/hcloud" ]; then
  HCLOUD_BIN="$HOME/projects/public/hetzner-cli/hcloud"
else
  HCLOUD_BIN="$(command -v hcloud 2>/dev/null || true)"
fi

hc() { "$HCLOUD_BIN" --context "$HCLOUD_CONTEXT" "$@"; }

# SSH into the rescue system. The clone is ephemeral and its IP is recycled
# from Hetzner's pool, so host-key checking is pointless here and actively
# harmful (a stale known_hosts entry would hard-fail the run).
SSH_OPTS=(
  -i "$SSH_KEY_FILE"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o GlobalKnownHostsFile=/dev/null
  -o LogLevel=ERROR
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=8
)

CLONE_NAME=""
CLONE_IP=""

rssh()      { ssh "${SSH_OPTS[@]}" "root@$CLONE_IP" "$@"; }
rscript()   { ssh "${SSH_OPTS[@]}" "root@$CLONE_IP" "bash -s"; }   # body on stdin

# ── cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
  local rc=$?
  trap - EXIT INT TERM

  [ -n "$CLONE_NAME" ] || exit "$rc"

  if [ "$KEEP_CLONE" = "1" ]; then
    warn "KEEP_CLONE=1 — leaving $CLONE_NAME ($CLONE_IP) running."
    warn "Delete it yourself:  $HCLOUD_BIN --context $HCLOUD_CONTEXT server delete $CLONE_NAME"
    exit "$rc"
  fi

  # Guard 1: the name must be one we generated.
  case "$CLONE_NAME" in
    "$CLONE_PREFIX"*) ;;
    *) warn "refusing to delete '$CLONE_NAME' — name lacks the '$CLONE_PREFIX' prefix"; exit "$rc" ;;
  esac

  # Guard 2: resolve the id and refuse if it is production.
  local id
  id="$(hc server describe "$CLONE_NAME" -o format='{{.ID}}' 2>/dev/null || true)"
  if [ "$id" = "$PROD_SERVER_ID" ]; then
    warn "refusing to delete '$CLONE_NAME' — it resolves to the PRODUCTION server id $PROD_SERVER_ID"
    exit "$rc"
  fi
  if [ -z "$id" ]; then
    dim "clone $CLONE_NAME already gone"
    exit "$rc"
  fi

  log "Destroying clone $CLONE_NAME (id $id)"
  hc server delete "$CLONE_NAME" >&2 || warn "failed to delete $CLONE_NAME — delete it manually!"
  exit "$rc"
}
trap cleanup EXIT INT TERM

# ── preflight ────────────────────────────────────────────────────────────────

preflight() {
  [ -n "$HCLOUD_BIN" ] && [ -x "$HCLOUD_BIN" ] \
    || die 2 "hcloud not found. Set HCLOUD_BIN, or build the clone at ~/projects/public/hetzner-cli."
  command -v jq  >/dev/null 2>&1 || die 2 "jq not installed"
  command -v ssh >/dev/null 2>&1 || die 2 "ssh not installed"
  [ -r "$SSH_KEY_FILE" ] || die 2 "ssh key not readable: $SSH_KEY_FILE"

  case "$RESTORE_WHAT" in
    sqlite|neo4j|both) ;;
    *) die 3 "RESTORE_WHAT must be sqlite|neo4j|both (got '$RESTORE_WHAT')" ;;
  esac

  hc server list -o noheader >/dev/null 2>&1 \
    || die 2 "hcloud context '$HCLOUD_CONTEXT' is not usable — check ~/.config/hcloud/cli.toml"

  # The key must be passphrase-free or already loaded in an agent: there is no
  # TTY under the job engine, so a passphrase prompt would hang forever.
  if grep -q ENCRYPTED "$SSH_KEY_FILE" 2>/dev/null || head -3 "$SSH_KEY_FILE" | grep -q bcrypt; then
    local fp
    fp="$(ssh-keygen -lf "$SSH_KEY_FILE.pub" 2>/dev/null | awk '{print $2}')"
    if [ -n "$fp" ] && ! ssh-add -l 2>/dev/null | grep -qF "$fp"; then
      warn "$SSH_KEY_FILE is passphrase-protected and not loaded in ssh-agent."
      warn "Run:  ssh-add $SSH_KEY_FILE     (otherwise this will hang with no TTY)"
    fi
  fi

  mkdir -p "$DEST_DIR"
}

# ── pick the backup image ────────────────────────────────────────────────────

pick_backup() {
  local json
  json="$(hc image list --type backup -o json)"

  # Two filters, both load-bearing:
  #   bound_to  — the project could hold images from other servers, and
  #               restoring the wrong disk would fail silently.
  #   status    — the nightly backup takes minutes to write. Run this script
  #               just after it fires and the newest image is still 'creating';
  #               restoring from a half-written image is not a thing we want to
  #               discover at 3am during a real incident.
  local mine
  mine="$(jq --argjson sid "$PROD_SERVER_ID" \
    '[.[] | select(.bound_to == $sid and .status == "available")]' <<<"$json")"
  [ "$(jq 'length' <<<"$mine")" -gt 0 ] \
    || die 1 "no available backup images bound to server $PROD_SERVER_ID ($PROD_SERVER_NAME)"

  local chosen
  if [ -n "$BACKUP_IMAGE_ID" ]; then
    chosen="$(jq --argjson id "$BACKUP_IMAGE_ID" '[.[] | select(.id == $id)] | first' <<<"$mine")"
    [ "$chosen" != "null" ] \
      || die 3 "image $BACKUP_IMAGE_ID is not an available backup of $PROD_SERVER_NAME (check 'hcloud image list --type backup -o json | jq' for its status)"
  else
    chosen="$(jq 'sort_by(.created) | last' <<<"$mine")"
  fi

  IMAGE_ID="$(jq -r '.id'            <<<"$chosen")"
  IMAGE_TYPE="$(jq -r '.type'        <<<"$chosen")"
  IMAGE_DESC="$(jq -r '.description' <<<"$chosen")"
  IMAGE_DISK="$(jq -r '.disk_size'   <<<"$chosen")"
  IMAGE_ARCH="$(jq -r '.architecture' <<<"$chosen")"

  # This script doubles as a disaster-recovery rehearsal, so it must exercise
  # the real backup restore path. A snapshot would prove nothing about whether
  # the nightly backups are actually restorable — refuse it outright.
  [ "$IMAGE_TYPE" = "backup" ] \
    || die 3 "image $IMAGE_ID is type '$IMAGE_TYPE', not 'backup' — this script restores from backups only"

  log "Backup: $IMAGE_DESC (id $IMAGE_ID, ${IMAGE_ARCH}, ${IMAGE_DISK}GB disk)"

  # A server type with a smaller disk than the image cannot boot it.
  local type_disk type_arch
  type_disk="$(hc server-type describe "$SERVER_TYPE" -o format='{{.Disk}}' 2>/dev/null || echo 0)"
  type_arch="$(hc server-type describe "$SERVER_TYPE" -o format='{{.Architecture}}' 2>/dev/null || echo '')"
  if [ "${type_disk:-0}" -lt "${IMAGE_DISK:-0}" ] 2>/dev/null; then
    die 3 "$SERVER_TYPE has a ${type_disk}GB disk but the image needs ${IMAGE_DISK}GB — pick a bigger SERVER_TYPE"
  fi
  if [ -n "$type_arch" ] && [ "$type_arch" != "$IMAGE_ARCH" ]; then
    die 3 "$SERVER_TYPE is '$type_arch' but the image is '$IMAGE_ARCH' — architectures must match"
  fi
}

# ── build the clone, boot it into rescue ─────────────────────────────────────

launch_clone() {
  CLONE_NAME="${CLONE_PREFIX}$(date +%Y%m%d-%H%M%S)"

  # --start-after-create=false is the whole trick: the disk gets written from
  # the backup, but the restored OS is never given a chance to boot. We flip it
  # into rescue before it ever powers on, so k3s cannot start.
  log "Creating clone $CLONE_NAME ($SERVER_TYPE, $LOCATION) from image $IMAGE_ID"
  hc server create \
    --name "$CLONE_NAME" \
    --type "$SERVER_TYPE" \
    --location "$LOCATION" \
    --image "$IMAGE_ID" \
    --ssh-key "$SSH_KEY_NAME" \
    --start-after-create=false >&2 \
    || die 1 "server create from backup image $IMAGE_ID failed — see above. This is a DR-relevant finding: if backups cannot seed a new server, the only restore path is 'server rebuild' onto production itself. See the notes at the bottom of this script."

  log "Enabling rescue mode (the restored OS will not boot)"
  hc server enable-rescue "$CLONE_NAME" --ssh-key "$SSH_KEY_NAME" >&2 \
    || die 1 "enable-rescue failed"

  log "Powering on into rescue"
  hc server poweron "$CLONE_NAME" >&2 || die 1 "poweron failed"

  CLONE_IP="$(hc server ip "$CLONE_NAME")"
  [ -n "$CLONE_IP" ] || die 1 "could not resolve clone IP"
  dim "clone ip: $CLONE_IP"

  log "Waiting for rescue SSH"
  local deadline=$((SECONDS + 300))
  until rssh true 2>/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || die 1 "timed out waiting for rescue SSH on $CLONE_IP"
    sleep 5
  done

  # Confirm we are actually in rescue and not the restored OS. If this check
  # fails, something booted that shouldn't have and we must not continue.
  local uname_r
  uname_r="$(rssh 'cat /etc/hostname 2>/dev/null || true')"
  case "$uname_r" in
    *rescue*) dim "confirmed rescue system ($uname_r)" ;;
    *) die 1 "expected the rescue system but host reports '$uname_r' — refusing to continue (the restored OS may be running)" ;;
  esac
}

# ── mount the restored disk ──────────────────────────────────────────────────

mount_disk() {
  log "Locating and mounting the restored root filesystem"

  local manifest
  manifest="$(rscript <<REMOTE
set -euo pipefail
mkdir -p $MOUNT_POINT

root=""
for p in \$(lsblk -nrpo NAME,TYPE | awk '\$2=="part"{print \$1}'); do
  if mount -o rw "\$p" $MOUNT_POINT 2>/dev/null; then
    if [ -d "$MOUNT_POINT/$K3S_STORAGE" ]; then root="\$p"; break; fi
    umount $MOUNT_POINT
  fi
done
[ -n "\$root" ] || { echo "no partition containing $K3S_STORAGE" >&2; exit 1; }

echo "ROOT_DEV=\$root"

# The SQLite PVC is the one holding the db file; the Neo4j PVC is the one
# holding a databases/ dir. Both match pvc-*_bf42-stats_* so we must
# discriminate on contents, not on the directory name.
sqlite_db=""
neo4j_dir=""
for d in $MOUNT_POINT/$K3S_STORAGE/pvc-*; do
  [ -d "\$d" ] || continue
  if [ -f "\$d/$SQLITE_FILENAME" ]; then sqlite_db="\$d/$SQLITE_FILENAME"; fi
  if [ -d "\$d/databases" ]; then neo4j_dir="\$d"; fi
done

echo "SQLITE_DB=\$sqlite_db"
echo "NEO4J_DIR=\$neo4j_dir"
[ -n "\$sqlite_db" ] && echo "SQLITE_BYTES=\$(du -sb "\$sqlite_db" | cut -f1)"
[ -n "\$sqlite_db" ] && [ -f "\${sqlite_db}-wal" ] && echo "WAL_BYTES=\$(du -sb "\${sqlite_db}-wal" | cut -f1)"
[ -n "\$neo4j_dir" ] && echo "NEO4J_BYTES=\$(du -sb "\$neo4j_dir" | cut -f1)"
exit 0
REMOTE
)" || die 1 "could not mount the restored disk"

  ROOT_DEV=""; SQLITE_DB=""; NEO4J_DIR=""; SQLITE_BYTES=0; WAL_BYTES=0; NEO4J_BYTES=0
  # Values are paths and integers we generated ourselves on the remote side.
  while IFS='=' read -r k v; do
    case "$k" in
      ROOT_DEV)     ROOT_DEV="$v" ;;
      SQLITE_DB)    SQLITE_DB="$v" ;;
      NEO4J_DIR)    NEO4J_DIR="$v" ;;
      SQLITE_BYTES) SQLITE_BYTES="$v" ;;
      WAL_BYTES)    WAL_BYTES="$v" ;;
      NEO4J_BYTES)  NEO4J_BYTES="$v" ;;
    esac
  done <<<"$manifest"

  dim "root device: $ROOT_DEV"
  [ -n "$SQLITE_DB" ] && dim "sqlite: $SQLITE_DB ($(human "$SQLITE_BYTES")${WAL_BYTES:+, wal $(human "$WAL_BYTES")})"
  [ -n "$NEO4J_DIR" ] && dim "neo4j:  $NEO4J_DIR ($(human "$NEO4J_BYTES"))"

  case "$RESTORE_WHAT" in
    sqlite|both) [ -n "$SQLITE_DB" ]  || die 1 "no $SQLITE_FILENAME found under $K3S_STORAGE" ;;
  esac
  case "$RESTORE_WHAT" in
    neo4j|both)  [ -n "$NEO4J_DIR" ]  || die 1 "no Neo4j store found under $K3S_STORAGE" ;;
  esac
}

human() { numfmt --to=iec-i --suffix=B "${1:-0}" 2>/dev/null || echo "${1:-0}B"; }

# ── sqlite: checkpoint on the box, then gzip + stream ────────────────────────

fetch_sqlite() {
  log "Preparing SQLite on the clone"

  # The backup is a crash-consistent snapshot of a running server, so there is
  # almost certainly an unmerged WAL. Checkpointing here — where no process can
  # possibly hold the database open — folds it back into the main file so we
  # ship one self-contained artifact instead of three files that must stay
  # together.
  local have_sqlite3
  have_sqlite3="$(rscript <<'REMOTE'
if command -v sqlite3 >/dev/null 2>&1; then echo yes; exit 0; fi
export DEBIAN_FRONTEND=noninteractive
if apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq sqlite3 >/dev/null 2>&1; then
  echo yes
else
  echo no
fi
REMOTE
)"

  if [ "$have_sqlite3" = "yes" ]; then
    log "Checkpointing WAL (TRUNCATE) + integrity check on the box"
    local result
    result="$(rscript <<REMOTE
set -euo pipefail
db="$SQLITE_DB"
sqlite3 "\$db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
if [ -f "\${db}-wal" ] && [ "\$(wc -c < "\${db}-wal")" -gt 0 ]; then
  echo "WAL_CLEAN=no"
else
  echo "WAL_CLEAN=yes"
fi
echo "INTEGRITY=\$(sqlite3 "\$db" 'PRAGMA integrity_check;' | head -1)"
echo "PAGES=\$(sqlite3 "\$db" 'PRAGMA page_count;')"
REMOTE
)"
    dim "$(tr '\n' ' ' <<<"$result")"

    grep -q 'INTEGRITY=ok' <<<"$result" \
      || die 1 "integrity_check did not return ok — see $BFSTATS_REPO/deploy/disaster-recovery/SQLITE_RECOVERY_PLAYBOOK.md"
    grep -q 'WAL_CLEAN=yes' <<<"$result" \
      || die 1 "WAL still non-empty after TRUNCATE checkpoint — refusing to ship a dirty database"

    SQLITE_LOCAL_CHECKPOINT=0
    log "Gzipping + downloading SQLite"
    rssh "gzip -c '$SQLITE_DB'" > "$DEST_DIR/playertracker.db.gz" \
      || die 1 "sqlite transfer failed"
  else
    # apt unreachable from rescue: ship the WAL and -shm alongside and let the
    # local sqlite3 do the recovery instead. Same outcome, one more step.
    warn "sqlite3 unavailable on the rescue system — shipping raw db + WAL, will checkpoint locally"
    SQLITE_LOCAL_CHECKPOINT=1
    log "Gzipping + downloading SQLite (raw, with WAL)"
    local dbdir dbbase
    dbdir="$(dirname "$SQLITE_DB")"; dbbase="$(basename "$SQLITE_DB")"
    rssh "tar -C '$dbdir' -czf - '$dbbase' \$( [ -f '$dbdir/$dbbase-wal' ] && echo '$dbbase-wal' ) \$( [ -f '$dbdir/$dbbase-shm' ] && echo '$dbbase-shm' )" \
      > "$DEST_DIR/playertracker-raw.tar.gz" || die 1 "sqlite transfer failed"
  fi
}

# ── neo4j: tar store + tx logs, gzip, stream ─────────────────────────────────

fetch_neo4j() {
  # No on-box preparation is possible: making a Neo4j store "clean" means
  # replaying the transaction logs, which only Neo4j itself can do at startup.
  # We ship databases/ and transactions/ together so the local instance can
  # recover from the unclean shutdown on first boot. Dropping transactions/
  # here would lose every committed write not yet flushed to the store.
  log "Gzipping + downloading Neo4j store (databases/ + transactions/)"
  rssh "tar -C '$NEO4J_DIR' -czf - ." > "$DEST_DIR/neo4j-store.tar.gz" \
    || die 1 "neo4j transfer failed"
}

# ── local post-processing ────────────────────────────────────────────────────

finish_sqlite() {
  if [ "${SQLITE_LOCAL_CHECKPOINT:-0}" = "1" ]; then
    command -v sqlite3 >/dev/null 2>&1 || { warn "sqlite3 not installed locally — leaving $DEST_DIR/playertracker-raw.tar.gz for manual recovery"; return; }
    log "Checkpointing locally (fallback path)"
    local work="$DEST_DIR/sqlite-work"
    rm -rf "$work"; mkdir -p "$work"
    tar -C "$work" -xzf "$DEST_DIR/playertracker-raw.tar.gz"
    sqlite3 "$work/$SQLITE_FILENAME" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
    local integrity
    integrity="$(sqlite3 "$work/$SQLITE_FILENAME" 'PRAGMA integrity_check;' | head -1)"
    [ "$integrity" = "ok" ] || die 1 "local integrity_check returned: $integrity"
    gzip -c "$work/$SQLITE_FILENAME" > "$DEST_DIR/playertracker.db.gz"
    rm -rf "$work" "$DEST_DIR/playertracker-raw.tar.gz"
    dim "integrity: ok"
  fi
}

report() {
  log "Done — artifacts in $DEST_DIR"
  ls -lh "$DEST_DIR" >&2
  cat >&2 <<EOF

${C_DIM}Load them locally:

  # SQLite
  gunzip -c $DEST_DIR/playertracker.db.gz > $BFSTATS_REPO/api/playertracker.db

  # Neo4j (compose volume; container must be stopped)
  docker compose -f $BFSTATS_REPO/docker-compose.dev.yml stop neo4j
  docker run --rm -v bfstats_neo4j-data:/data -v $DEST_DIR:/backup:ro \\
    alpine sh -c 'rm -rf /data/databases /data/transactions && tar -C /data -xzf /backup/neo4j-store.tar.gz'
  docker compose -f $BFSTATS_REPO/docker-compose.dev.yml start neo4j

  # Verify the volume name first: docker volume ls | grep neo4j
  # Neo4j replays the transaction logs on first start — watch the logs.${C_OFF}
EOF
}

# ── main ─────────────────────────────────────────────────────────────────────

preflight
pick_backup
launch_clone
mount_disk

case "$RESTORE_WHAT" in
  sqlite) fetch_sqlite ;;
  neo4j)  fetch_neo4j ;;
  both)   fetch_sqlite; fetch_neo4j ;;
esac

finish_sqlite
report

# ── notes: this script as a DR rehearsal ─────────────────────────────────────
#
# Every successful run is a live proof of three things that are otherwise only
# assumed:
#
#   1. The nightly backups exist and are bound to the right server.
#   2. A backup can actually seed a bootable disk — i.e. the images are not
#      silently corrupt.
#   3. The databases inside come back consistent (integrity_check = ok, and a
#      Neo4j store that replays its transaction logs).
#
# Deliberately NOT used, despite being easier:
#
#   - Snapshots. `hcloud server create-image --type snapshot` reads production's
#     live disk. It would produce a usable set of database files, but it proves
#     nothing about whether the backups are restorable — which is the entire
#     question DR needs answered. Snapshots are rejected in pick_backup().
#   - `hcloud server rebuild --image <backup> <server>`. This is Hetzner's
#     first-class restore path and what a real disaster would use, but it
#     overwrites the target server's disk. Never point it at production as a
#     drill.
#
# If `server create --image <backup-id>` is ever rejected by the API, that is
# itself the finding: it would mean the only way to use these backups is
# `server rebuild` onto production, so a real restore is inherently destructive
# and cannot be rehearsed without downtime. Record it and rethink the strategy
# (e.g. schedule application-level dumps to object storage alongside the
# disk-level backups).

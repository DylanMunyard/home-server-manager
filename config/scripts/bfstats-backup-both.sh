#!/usr/bin/env bash
# bfstats-backup-both — backup Neo4j and SQLite to Azure, then publish the E2E seed DB
#
# Disables DISABLE_BACKGROUND_PROCESSING to pause all database writes while keeping the API
# running for read traffic. Scales the Neo4j deployment to 0 (ensuring it flushes and closes
# store files cleanly), archives the Neo4j PVC and checkpoints/copies the SQLite DB, compresses
# both with zstd (parallel), and uploads to Azure. Logs progress with timestamps.
# Re-enables background jobs and restarts Neo4j on completion (success or failure).
#
# Neo4j 5 Community Edition stores its data at:
#   <pvc-host-path>/databases/neo4j/   (store files)
#   <pvc-host-path>/transactions/neo4j/ (tx logs)
# Both are included in the archive for a complete restorable backup.
#
# SQLite database is checkpointed with TRUNCATE mode to ensure a consistent snapshot
# without any open connections.
#
# Finally — if E2E_GH_TOKEN is supplied — it carves the ~25 G SQLite backup down to the
# ~176 MB slice the bfstats E2E suite needs and publishes it to the `e2e-fixture` GitHub
# release, where CI picks it up. This phase runs LAST, after Azure has both archives, so
# it can never cost you a backup. Adds a few minutes: the carve is ~20 s (it reads through
# indexes rather than scanning), and `zstd -19` down to ~24 MB is the rest of it. See
# "E2E seed DB" below.
#
# params:
#   NAMESPACE:  { label: "k3s namespace for apps", default: "bf42-stats" }
#   NEO4J_PVC_PATH: { label: "Host path to Neo4j PVC (blank = auto-locate)", default: "" }
#   DB_PATH:    { label: "Path to sqlite db (blank = auto-locate on k3s PVC)", default: "" }
#   BACKUP_DIR: { label: "Host backup directory", default: "/backup" }
#   AZURE_SAS_URL: { label: "Azure Blob SAS URL (e.g., https://account.blob.core.windows.net/container?sv=...)", required: true }
#   E2E_GH_TOKEN: { label: "GitHub token with contents:write (blank = skip the seed DB entirely)", default: "" }
#   E2E_GH_REPO: { label: "Repo owning the e2e-fixture release", default: "sila-skandia/bfstats" }
#   E2E_KEEP_PROFILES: { label: "Comma-separated Users.Id whose linked gamertags survive (blank = drop all)", default: "1" }
#   E2E_FACT_DAYS: { label: "Days of rounds/sessions the seed DB keeps", default: "14" }
#   E2E_OBS_ROUNDS: { label: "Newest rounds that keep per-observation detail", default: "1000" }
# nodes: [ hetzner/bfstats ]
# detach: true
# confirm: This will pause background jobs and shut down Neo4j cleanly, backing up both Neo4j and SQLite to Azure (~15-20 min total). API reads stay online. With E2E_GH_TOKEN set it also PUBLISHES a redacted seed DB to a PUBLIC GitHub release. Continue?
#
# ── E2E seed DB ───────────────────────────────────────────────────────────────
# Formerly bfstats' own scripts/make-e2e-fixture.sh, run by hand off a downloaded
# backup. It lives here now because the only input it ever wanted is the
# checkpointed copy this script already makes, and it belongs next to the backup
# that produces it rather than in the repo that consumes it.
#
# THIS PUBLISHES DATA to a PUBLIC repository. Player names, servers and scores are
# already public on bfstats.io; two things are not, and both are handled here:
#   - Emails are always redacted (this runbook has no --keep-emails equivalent),
#     backed by a schema-driven sweep that aborts on any address it doesn't
#     recognise, so a future migration can't quietly add a leaking column.
#   - The account-to-gamertag mapping in UserPlayerNames/UserBuddies/
#     UserFavoriteServers is dropped for everyone except E2E_KEEP_PROFILES.
#     Default `1` = the owner's only. Blank drops all of them.
#
# The paired Neo4j graph (neo4j.dump on the same release) is NOT built here — it
# is rebuilt from this fixture by the app's own ETL, so it still comes from
# bfstats' scripts/make-e2e-graph.sh. CI never loads it (verify.sh only touches
# it under E2E_NEO4J=1), so publishing the SQLite half alone keeps CI current.

set -euo pipefail

command -v kubectl >/dev/null 2>&1 || { echo "kubectl not installed on host" >&2; exit 2; }
command -v tar     >/dev/null 2>&1 || { echo "tar not installed on host" >&2; exit 2; }
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 not installed on host" >&2; exit 2; }
command -v zstd    >/dev/null 2>&1 || { echo "Installing zstd..." >&2; apt-get update && apt-get install -y zstd >&2; }
command -v bc      >/dev/null 2>&1 || { echo "Installing bc..." >&2; apt-get install -y bc >&2; }
command -v azcopy  >/dev/null 2>&1 || { echo "Installing azcopy..." >&2; curl -sL https://aka.ms/downloadazcopy-v10-linux-arm64 -o /tmp/azcopy.tar.gz && tar -xzf /tmp/azcopy.tar.gz -C /tmp && sudo mv /tmp/azcopy_linux_arm64_*/azcopy /usr/local/bin/ && chmod +x /usr/local/bin/azcopy >&2; }
[ -z "${AZURE_SAS_URL:-}" ] && { echo "AZURE_SAS_URL parameter is required" >&2; exit 1; }

NS="${NAMESPACE:-bf42-stats}"
NEO4J_DEP="neo4j"
APP_DEP="bf42-stats"
BACKUP_DIR="${BACKUP_DIR:-/backup}"

log() { echo "[$(date +'%H:%M:%S')] $*" >&2; }

locate_pvc() {
  local dep="$1"
  local pvc_path="${2:-}"

  if [ -n "$pvc_path" ]; then
    [ -d "$pvc_path" ] || { log "ERROR: PVC path not found: $pvc_path"; exit 1; }
    echo "$pvc_path"
    return
  fi

  local pvc_name=$(kubectl get deployment "$dep" -n "$NS" -o jsonpath='{.spec.template.spec.volumes[?(@.persistentVolumeClaim)].persistentVolumeClaim.claimName}' 2>/dev/null)
  if [ -z "$pvc_name" ]; then
    log "ERROR: Could not find $dep PVC name from deployment"
    exit 1
  fi

  pvc_path=$(find /var/lib/rancher/k3s/storage /mnt -maxdepth 5 -type d -name "*${pvc_name}" 2>/dev/null | head -1)
  if [ -z "$pvc_path" ]; then
    log "ERROR: Could not find mounted PVC at /var/lib/rancher/k3s/storage for ${pvc_name}"
    log "Hint: Set NEO4J_PVC_PATH parameter with the correct host path"
    exit 1
  fi

  log "Located PVC ${pvc_name} at ${pvc_path}"
  echo "$pvc_path"
}

locate_db() {
  local db="${1:-}"

  if [ -n "$db" ]; then
    [ -f "$db" ] || { log "ERROR: SQLite DB not found: $db"; exit 1; }
    echo "$db"
    return
  fi

  local pvc_name=$(kubectl get deployment bf42-stats -n "$NS" -o jsonpath='{.spec.template.spec.volumes[?(@.persistentVolumeClaim)].persistentVolumeClaim.claimName}' 2>/dev/null)
  if [ -z "$pvc_name" ]; then
    log "ERROR: Could not find bf42-stats PVC name from deployment"
    exit 1
  fi

  db=$(find /var/lib/rancher/k3s/storage /mnt -maxdepth 5 -type f -name "playertracker.db" 2>/dev/null | head -1)
  if [ -z "$db" ]; then
    log "ERROR: Could not find playertracker.db in known mount paths"
    log "Hint: Set DB_PATH parameter with the correct path"
    exit 1
  fi

  log "Located database at: $db"
  echo "$db"
}

compress_and_report() {
  local backup_file="$1"
  local name="$2"

  log "Compressing $name with zstd (ultra mode, long-range matching, all cores)..."
  start=$(date +%s)
  zstd -f --ultra --long -T0 "$backup_file" -o "$backup_file.zst"
  end=$(date +%s)
  elapsed=$((end - start))

  local backup_file_zst="${backup_file}.zst"
  local compressed_size=$(du -sh "$backup_file_zst" | cut -f1)
  local original_size=$(du -sh "$backup_file" | cut -f1)
  local compression_ratio=$(echo "scale=1; $(stat -c%s "$backup_file") * 100 / $(stat -c%s "$backup_file_zst")" | bc)
  log "$name compression complete (${elapsed}s, ${original_size} → ${compressed_size}, ${compression_ratio}%)"

  echo "$backup_file_zst"
}

upload_to_azure() {
  local backup_file="$1"
  local name="$2"

  log "Uploading $name to Azure..."
  start=$(date +%s)
  # </dev/null is load-bearing: runbooks run as `bash -s` with the script itself
  # on stdin, and azcopy reads stdin for lifecycle messages — without this it
  # swallows the rest of the script and bash silently exits at EOF.
  azcopy copy "$backup_file" "${AZURE_SAS_URL}" --overwrite=true </dev/null
  end=$(date +%s)
  elapsed=$((end - start))

  log "$name upload complete (${elapsed}s)"
}

# ── E2E seed DB helpers ───────────────────────────────────────────────────────

# gh isn't packaged in Debian stable, so fetch the release tarball like azcopy above.
install_gh() {
  if command -v gh >/dev/null 2>&1; then return 0; fi

  local arch ver url tmp
  case "$(uname -m)" in
    aarch64|arm64) arch=arm64 ;;
    x86_64|amd64)  arch=amd64 ;;
    *) log "ERROR: no gh build for $(uname -m)"; return 1 ;;
  esac

  log "Installing gh CLI (${arch})..."
  ver=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest \
        | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)
  [ -n "$ver" ] || { log "ERROR: could not resolve the latest gh release"; return 1; }

  tmp=$(mktemp -d)
  url="https://github.com/cli/cli/releases/download/v${ver}/gh_${ver}_linux_${arch}.tar.gz"
  if ! curl -fsSL "$url" -o "$tmp/gh.tgz"; then
    rm -rf "$tmp"; log "ERROR: gh download failed — $url"; return 1
  fi
  tar -xzf "$tmp/gh.tgz" -C "$tmp"
  install -m 0755 "$tmp"/gh_*/bin/gh /usr/local/bin/gh
  rm -rf "$tmp"
  log "Installed gh ${ver}"
}

# Carve the ~25 G backup down to the rows the E2E suite actually needs.
# Reads the source read-only; writes $fixture + ${fixture%.db}.meta.
#
# The asset basenames are load-bearing: the bfstats CI workflow does
# `gh release download e2e-fixture` then `zstd -d *.zst --rm`, and verify.sh
# reads template.db / template.meta by those exact names. Don't rename them.
build_e2e_fixture() {
  local src="$1" fixture="$2"
  local meta="${fixture%.db}.meta"
  local e2e_dir; e2e_dir="$(dirname "$fixture")"

  local fact_days="${E2E_FACT_DAYS:-14}"
  local obs_rounds="${E2E_OBS_ROUNDS:-1000}"

  # E2eDatabaseSeed's synthetic admin. Not a real address, so the leak sweep
  # below must not trip on it.
  local seed_email="admin@bfstats.io"

  local ro="file:${src}?mode=ro"
  sqlite3 "$ro" "SELECT 1 FROM Rounds LIMIT 1;" >/dev/null 2>&1 \
    || { log "ERROR: source has no readable Rounds table — is this a playertracker.db?"; return 1; }

  # Anchor on the SOURCE's own clock, never wall clock. A backup is always
  # slightly stale; "now() minus N days" silently produces an empty fixture.
  local anchor; anchor="$(sqlite3 "$ro" "SELECT MAX(StartTime) FROM Rounds;")"
  [ -n "$anchor" ] || { log "ERROR: could not determine an anchor (Rounds is empty)"; return 1; }

  local fact_from fact_ym
  fact_from="$(date -u -d "${anchor%% *} -${fact_days} days" +%Y-%m-%d)"
  fact_ym=$(( $(date -u -d "$fact_from" +%Y) * 100 + 10#$(date -u -d "$fact_from" +%m) ))

  # Scratch lives beside the fixture, not in /tmp — the intermediate is a few
  # hundred MB and /tmp on this box is not where that belongs.
  local work; work="$(mktemp -d -p "$e2e_dir")"
  local tmp_out="${work}/template.db"

  log "Seed DB anchor ${anchor}, facts from ${fact_from} (month tables from ${fact_ym}), detail on newest ${obs_rounds} rounds"

  # DDL comes from sqlite_master, not `.schema`: index DDL spans multiple lines,
  # so a line-oriented split tears statements in half. Indexes are applied after
  # the inserts — building 122 of them incrementally is far slower.
  sqlite3 "$ro" "SELECT sql||';' FROM sqlite_master
                 WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%';" \
    > "$work/tables.sql"
  sqlite3 "$ro" "SELECT sql||';' FROM sqlite_master
                 WHERE type='index' AND sql IS NOT NULL;" > "$work/indexes.sql"
  sqlite3 "$tmp_out" < "$work/tables.sql"

  # Reference/config tables copied whole. Emitted only if the source actually
  # has them, so an older production schema does not abort the run.
  local whole_tables=(
    Servers Users UserPlayerNames UserBuddies UserFavoriteServers
    app_data __EFMigrationsHistory
    HourlyActivityPatterns HourlyPlayerPredictions MapGlobalAverages
    ServerHourlyPatterns
    TournamentTheme Tournaments TournamentTeams TournamentTeamPlayers
    TournamentMatches TournamentMatchMaps TournamentMatchResults
    TournamentTeamRankings TournamentWeekDates TournamentPosts
    TournamentComments TournamentMatchComments TournamentFiles TournamentMatchFiles
    PlayerComments ServerComments
  )
  : > "$work/whole.sql"
  local t
  for t in "${whole_tables[@]}"; do
    if [ -n "$(sqlite3 "$ro" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$t';")" ]; then
      echo "INSERT INTO main.\"$t\" SELECT * FROM src.\"$t\";" >> "$work/whole.sql"
    else
      log "  (source has no $t — skipped)"
    fi
  done

  # Never copied: RefreshTokens, AdminPins (credentials); PlayerWrappedCaches,
  # ServerWrappedCaches (regenerable JSON blobs); AdminAuditLogs, AIChatFeedback,
  # TournamentImageIndices, __EFMigrationsLock.

  log "Extracting seed DB..."
  local t0; t0=$(date +%s)
  sqlite3 "$tmp_out" >/dev/null <<SQL
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
ATTACH DATABASE '$ro' AS src;

.read $work/whole.sql

-- Rounds define the window; everything else keys off the retained round set.
INSERT INTO main.Rounds
  SELECT * FROM src.Rounds
  WHERE StartTime >= '$fact_from' AND StartTime <= '$anchor';

-- Sessions follow their round rather than their own StartTime. A session can
-- begin inside the window on a round that began before it; filtering on the
-- session date leaves those pointing at a round we did not keep.
INSERT INTO main.PlayerSessions
  SELECT * FROM src.PlayerSessions
  WHERE RoundId IN (SELECT RoundId FROM main.Rounds)
     OR (RoundId IS NULL AND StartTime >= '$fact_from' AND StartTime <= '$anchor');

INSERT INTO main.ServerOnlineCounts
  SELECT * FROM src.ServerOnlineCounts
  WHERE HourTimestamp >= '$fact_from' AND HourTimestamp <= '$anchor';

INSERT INTO main.Players
  SELECT * FROM src.Players
  WHERE Name IN (SELECT DISTINCT PlayerName FROM main.PlayerSessions);

-- Per-player aggregates are scoped to the (player, server) pairs that actually
-- appear in the window. Filtering on PlayerName alone drags in every server the
-- player ever touched, which on its own doubled the fixture.
CREATE TEMP TABLE kept_pairs AS
  SELECT DISTINCT PlayerName, ServerGuid FROM main.PlayerSessions;
CREATE INDEX temp.ix_kept_pairs ON kept_pairs(PlayerName, ServerGuid);
CREATE TEMP TABLE kept_servers AS
  SELECT DISTINCT ServerGuid FROM main.PlayerSessions;

-- Month-granular tables can only be cut to whole months, so a 14-day window
-- still pulls the containing month. That is the floor on fixture size.
INSERT INTO main.PlayerMapStats
  SELECT a.* FROM src.PlayerMapStats a
  JOIN kept_pairs k ON k.PlayerName = a.PlayerName AND k.ServerGuid = a.ServerGuid
  WHERE a.Year * 100 + a.Month >= $fact_ym;

INSERT INTO main.PlayerServerStats
  SELECT a.* FROM src.PlayerServerStats a
  JOIN kept_pairs k ON k.PlayerName = a.PlayerName AND k.ServerGuid = a.ServerGuid
  WHERE a.UpdatedAt >= '$fact_from';

INSERT INTO main.ServerPlayerRankings
  SELECT a.* FROM src.ServerPlayerRankings a
  JOIN kept_pairs k ON k.PlayerName = a.PlayerName AND k.ServerGuid = a.ServerGuid
  WHERE a.Year * 100 + a.Month >= $fact_ym;

INSERT INTO main.PlayerStatsMonthly
  SELECT * FROM src.PlayerStatsMonthly
  WHERE Year * 100 + Month >= $fact_ym
    AND PlayerName IN (SELECT Name FROM main.Players);

INSERT INTO main.PlayerAchievements
  SELECT * FROM src.PlayerAchievements
  WHERE AchievedAt >= '$fact_from' AND AchievedAt <= '$anchor'
    AND PlayerName IN (SELECT Name FROM main.Players);

INSERT INTO main.PlayerBestScores
  SELECT * FROM src.PlayerBestScores
  WHERE PlayerName IN (SELECT Name FROM main.Players);

INSERT INTO main.ServerMapStats
  SELECT a.* FROM src.ServerMapStats a
  WHERE a.Year * 100 + a.Month >= $fact_ym
    AND a.ServerGuid IN (SELECT ServerGuid FROM kept_servers);

INSERT INTO main.MapServerHourlyPatterns
  SELECT * FROM src.MapServerHourlyPatterns
  WHERE ServerGuid IN (SELECT ServerGuid FROM kept_servers);

INSERT INTO main.ServerBestScoreRaw
  SELECT * FROM src.ServerBestScoreRaw
  WHERE SessionId IN (SELECT SessionId FROM main.PlayerSessions);

-- Observations are bounded by round COUNT, not by days, so fixture size does
-- not swing with how busy production happened to be that fortnight. This table
-- is ~78% of the source file; nothing else here matters as much.
CREATE TEMP TABLE detail_sessions AS
  SELECT SessionId FROM main.PlayerSessions
  WHERE RoundId IN (
    SELECT RoundId FROM main.Rounds ORDER BY StartTime DESC LIMIT $obs_rounds
  );

INSERT INTO main.PlayerObservations
  SELECT * FROM src.PlayerObservations
  WHERE SessionId IN (SELECT SessionId FROM detail_sessions);

-- ObservationCount would otherwise advertise rows that are not here, and the
-- round report renders straight off it.
UPDATE main.PlayerSessions
   SET ObservationCount = 0
 WHERE SessionId NOT IN (SELECT SessionId FROM detail_sessions);

-- Referential closure. The whole-copied tables reference players and rounds
-- from outside the window; without this the fixture carries ~490 dangling FKs,
-- and a tournament with a missing Organizer breaks the tournament list.
INSERT INTO main.Players
  SELECT * FROM src.Players
  WHERE Name NOT IN (SELECT Name FROM main.Players)
    AND Name IN (
      SELECT Organizer            FROM main.Tournaments           WHERE Organizer IS NOT NULL
      UNION SELECT PlayerName     FROM main.TournamentTeamPlayers WHERE PlayerName IS NOT NULL
      UNION SELECT BuddyPlayerName FROM main.UserBuddies          WHERE BuddyPlayerName IS NOT NULL
      UNION SELECT PlayerName     FROM main.ServerPlayerRankings  WHERE PlayerName IS NOT NULL
    );

INSERT INTO main.Rounds
  SELECT * FROM src.Rounds
  WHERE RoundId NOT IN (SELECT RoundId FROM main.Rounds)
    AND RoundId IN (SELECT RoundId FROM main.TournamentMatchResults WHERE RoundId IS NOT NULL);
SQL

  # Player and server names are public; account emails are not. The suite
  # authenticates as E2eDatabaseSeed's own admin@bfstats.io, so nothing depends
  # on these values.
  # LastLoggedIn is NOT NULL, so it stays as-is; the email is the identifier.
  # Tournaments and TournamentPosts keep denormalised copies of the creator's
  # address; both carry the user id too, so they redact to the same value.
  sqlite3 "$tmp_out" <<'SQL'
UPDATE Users            SET Email              = 'user' || Id || '@e2e.invalid';
UPDATE Tournaments      SET CreatedByUserEmail = 'user' || CreatedByUserId || '@e2e.invalid'
  WHERE CreatedByUserEmail IS NOT NULL;
UPDATE TournamentPosts  SET CreatedByUserEmail = 'user' || CreatedByUserId || '@e2e.invalid'
  WHERE CreatedByUserEmail IS NOT NULL;
SQL
  log "Redacted emails ($(sqlite3 "$tmp_out" "SELECT COUNT(*) FROM Users;") users, \
$(sqlite3 "$tmp_out" "SELECT COUNT(*) FROM Tournaments WHERE CreatedByUserEmail IS NOT NULL;") tournaments, \
$(sqlite3 "$tmp_out" "SELECT COUNT(*) FROM TournamentPosts WHERE CreatedByUserEmail IS NOT NULL;") posts)"

  # Schema-driven backstop. The three columns above were found by sweeping for
  # them, not by reading the model — so sweep every time instead, and fail
  # rather than publish an address a future migration adds somewhere new.
  local leaks="" c n
  for t in $(sqlite3 "$tmp_out" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"); do
    for c in $(sqlite3 "$tmp_out" "PRAGMA table_info(\"$t\");" | awk -F'|' '$2 ~ /[Ee]mail/ {print $2}'); do
      n="$(sqlite3 "$tmp_out" "SELECT COUNT(*) FROM \"$t\"
             WHERE \"$c\" IS NOT NULL
               AND \"$c\" NOT LIKE '%@e2e.invalid'
               AND \"$c\" <> '${seed_email}';")"
      [ "${n:-0}" -gt 0 ] && leaks="${leaks}
       $t.$c: $n row(s)"
    done
  done
  if [ -n "$leaks" ]; then
    log "ERROR: unredacted addresses remain — refusing to publish:$leaks"
    log "Add them to the redaction block in this runbook."
    return 1
  fi

  # Users rows themselves have to stay — tournaments, teams and comments all
  # reference them — but the three profile tables are leaves that nothing points
  # at, so they can be emptied without dangling anything. They hold the
  # account-to-gamertag mapping, which unlike player names and scores is behind
  # auth in production and is not otherwise public.
  local keep_sql="${E2E_KEEP_PROFILES:-}"
  if [ -z "$keep_sql" ]; then
    keep_sql="NULL"
  elif ! [[ "$keep_sql" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
    log "ERROR: E2E_KEEP_PROFILES wants comma-separated numeric ids, got '$keep_sql'"
    return 1
  fi
  sqlite3 "$tmp_out" <<SQL
DELETE FROM UserPlayerNames     WHERE UserId NOT IN ($keep_sql);
DELETE FROM UserBuddies         WHERE UserId NOT IN ($keep_sql);
DELETE FROM UserFavoriteServers WHERE UserId NOT IN ($keep_sql);
SQL
  if [ "$keep_sql" != "NULL" ]; then
    log "Kept profiles for user id(s) ${keep_sql} — $(sqlite3 "$tmp_out" \
      "SELECT (SELECT COUNT(*) FROM UserPlayerNames)||' names, '||
              (SELECT COUNT(*) FROM UserBuddies)||' buddies, '||
              (SELECT COUNT(*) FROM UserFavoriteServers)||' favourites';")"
  else
    log "Dropped all linked profiles (set E2E_KEEP_PROFILES to retain some)"
  fi

  local t1; t1=$(date +%s); log "  extract: $((t1-t0))s"
  sqlite3 "$tmp_out" < "$work/indexes.sql"
  local t2; t2=$(date +%s); log "  indexes: $((t2-t1))s"

  # The app leans on sqlite_stat1 for plan selection (SqliteConnectionInterceptor),
  # so the fixture ships with statistics rather than making the first run pay.
  sqlite3 "$tmp_out" "ANALYZE; VACUUM; PRAGMA journal_mode=WAL;" >/dev/null
  local t3; t3=$(date +%s); log "  analyze+vacuum: $((t3-t2))s"

  # Production carries dangling foreign keys of its own — SQLite only enforces
  # ON DELETE CASCADE when foreign_keys=ON, and nothing in the app sets it, so
  # deleted parents leave orphans behind. Those are faithfully copied here. Drop
  # them: a fixture should be cleaner than production, and a dangling parent is a
  # confusing test failure rather than a useful one.
  #
  # Deliberately not a hard failure, but the check below IS a hard gate — if
  # orphans remain after one sweep, the extraction itself introduced them.
  local orphans=0 child rowid parent rest
  while read -r child rowid parent rest; do
    [ -n "$child" ] || continue
    sqlite3 "$tmp_out" "DELETE FROM \"$child\" WHERE rowid = $rowid;"
    orphans=$((orphans + 1))
  done < <(sqlite3 -separator ' ' "$tmp_out" "PRAGMA foreign_key_check;")
  [ "$orphans" -gt 0 ] && log "Pruned $orphans orphaned row(s) inherited from the source"

  local fk; fk="$(sqlite3 "$tmp_out" "PRAGMA foreign_key_check;" | head -5)"
  if [ -n "$fk" ]; then
    log "ERROR: seed DB still has dangling foreign keys after pruning — the extraction introduced them:"
    log "$fk"
    return 1
  fi

  # Per-tier floors. An empty tier means the window is wrong, and a fixture that
  # looks built but isn't is worse than no fixture at all.
  local table min rows
  while read -r table min; do
    rows="$(sqlite3 "$tmp_out" "SELECT COUNT(*) FROM \"$table\";")"
    if [ "$rows" -lt "$min" ]; then
      log "ERROR: $table has $rows rows, expected >= $min. Window is probably wrong."
      return 1
    fi
    log "  $(printf '%-22s %s' "$table" "$rows")"
  done <<'ROWS'
Servers 1
Rounds 100
PlayerSessions 100
Players 50
PlayerObservations 100
PlayerServerStats 1
ROWS

  mv -f "$tmp_out" "$fixture"
  rm -rf "$work" "${fixture}-wal" "${fixture}-shm"

  cat > "$meta" <<META
source=$src
source_mtime=$(date -u -d "@$(stat -c %Y "$src")" +%Y-%m-%dT%H:%M:%SZ)
anchor=$anchor
fact_days=$fact_days
fact_from=$fact_from
obs_rounds=$obs_rounds
emails=redacted
kept_profiles=${E2E_KEEP_PROFILES:-none}
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
built_by=bfstats-backup-both runbook
migration_head=$(sqlite3 "$fixture" "SELECT MigrationId FROM __EFMigrationsHistory ORDER BY MigrationId DESC LIMIT 1;" 2>/dev/null)
META

  log "Seed DB built: $(du -h "$fixture" | cut -f1) in $((t3-t0))s"
}

# Compress and attach to the `e2e-fixture` release. The release is a plain
# storage tag, not a software release — assets are clobbered in place each run.
publish_e2e_fixture() {
  local fixture="$1" repo="$2"
  local meta="${fixture%.db}.meta"

  # Belt-and-braces: this runbook always redacts, so a meta that says otherwise
  # means something upstream changed. Never publish it.
  if ! grep -q '^emails=redacted' "$meta"; then
    log "ERROR: ${meta} does not record redacted emails — refusing to publish"
    return 1
  fi

  log "Compressing seed DB for release..."
  zstd -19 -T0 -q -f "$fixture" -o "${fixture}.zst"
  log "  $(basename "$fixture").zst — $(du -h "${fixture}.zst" | cut -f1)"

  # </dev/null on every gh call for the same reason azcopy needs it above: this
  # script arrives on stdin via `bash -s`, and anything that reads stdin eats the
  # rest of it. gh also treats a non-TTY stdin as "safe to prompt into".
  export GH_TOKEN="$E2E_GH_TOKEN"
  if ! gh release view e2e-fixture -R "$repo" >/dev/null 2>&1 </dev/null; then
    log "Creating release e2e-fixture on ${repo}..."
    gh release create e2e-fixture -R "$repo" \
      --title "E2E fixtures" \
      --notes "Slim SQLite + Neo4j fixtures for the E2E suite. The SQLite half is rebuilt from production by the bfstats-backup-both runbook in home-server-mgr; the Neo4j half by scripts/make-e2e-graph.sh. See features/e2e-real-data-fixtures/. Not a software release." \
      --latest=false >&2 </dev/null
  fi

  log "Uploading seed DB to ${repo} release e2e-fixture..."
  gh release upload e2e-fixture -R "$repo" \
    "${fixture}.zst" "$meta" --clobber >&2 </dev/null

  log "Seed DB published — CI picks it up on the next run"
}

# Phase 7 restores the cluster as soon as the copies are done, so the trap only
# has to back out an *early* exit. Guarded on a state flag rather than $? because
# the failure mode we actually hit (azcopy eating the script off stdin) exits 0 —
# an exit-code guard would have left Neo4j scaled to 0. Backups always cleaned up.
restored=0
trap 'if [ "${restored:-0}" -ne 1 ]; then
        log "Backing out: re-enabling background processing and restarting Neo4j..."
        kubectl set env deployment/"${APP_DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=false >&2 || true
        kubectl scale deployment/"${NEO4J_DEP}" -n "${NS}" --replicas=1 >&2 || true
        kubectl rollout status deployment/"${APP_DEP}" -n "${NS}" --timeout=120s >&2 || true
      fi
      log "Cleaning up backup files from ${BACKUP_DIR}..."
      rm -f "${BACKUP_DIR}"/bfstats-neo4j-latest.* "${BACKUP_DIR}"/bfstats-sqlite-latest.* 2>/dev/null || true
      rm -rf "${BACKUP_DIR}/e2e" 2>/dev/null || true' EXIT

# Create backup directory if needed
mkdir -p "$BACKUP_DIR"

# ── Phase 1: disable background processing ───────────────────────────────────
log "Disabling background processing (API reads stay online)..."
kubectl set env deployment/"${APP_DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=true >&2

log "Waiting for rollout to complete (pods restarting)..."
kubectl rollout status deployment/"${APP_DEP}" -n "${NS}" --timeout=120s >&2

# ── Phase 2: shut down Neo4j cleanly ──────────────────────────────────────────
log "Scaling down ${NEO4J_DEP} (flushing and closing store files)..."
kubectl scale deployment/"${NEO4J_DEP}" -n "${NS}" --replicas=0 >&2

log "Waiting for neo4j pod to terminate..."
kubectl wait --for=delete pod -l "app=${NEO4J_DEP}" -n "${NS}" --timeout=120s >&2 2>/dev/null || true
sleep 2

# ── Phase 3: locate Neo4j PVC and SQLite DB ───────────────────────────────────
pvc_path=$(locate_pvc "$NEO4J_DEP" "${NEO4J_PVC_PATH:-}")
pvc_size=$(du -sh "$pvc_path" | cut -f1)
log "Neo4j data directory located (size: ${pvc_size})"

db=$(locate_db "${DB_PATH:-}")
db_size=$(du -sh "$db" | cut -f1)
log "SQLite database located (size: ${db_size})"

# ── Phase 5: archive Neo4j PVC to tar ─────────────────────────────────────────
neo4j_backup_file="${BACKUP_DIR}/bfstats-neo4j-latest.tar"
log "Archiving Neo4j data to ${neo4j_backup_file}..."

start=$(date +%s)
tar -cf "$neo4j_backup_file" -C "$pvc_path" .
end=$(date +%s)
elapsed=$((end - start))

neo4j_backup_size=$(du -sh "$neo4j_backup_file" | cut -f1)
log "Archive complete (${elapsed}s, size: ${neo4j_backup_size})"

# ── Phase 6: checkpoint SQLite WAL and copy to backup dir ──────────────────────
log "Checkpointing SQLite WAL (TRUNCATE mode)..."
start=$(date +%s)
sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
end=$(date +%s)
log "Checkpoint complete ($((end - start))s)"

# Sanity check: if a -wal file still exists after TRUNCATE it means there are
# uncommitted transactions — abort rather than copy a potentially dirty state.
wal_size=$(stat -c%s "${db}-wal" 2>/dev/null || echo 0)
if [ "$wal_size" -gt 0 ]; then
  log "ERROR: WAL file is non-empty after TRUNCATE checkpoint — aborting to protect data integrity"
  exit 1
fi

sqlite_backup_file="${BACKUP_DIR}/bfstats-sqlite-latest.db"
log "Copying SQLite database to ${sqlite_backup_file}..."

start=$(date +%s)
cp "$db" "$sqlite_backup_file"
end=$(date +%s)
elapsed=$((end - start))

sqlite_backup_size=$(du -sh "$sqlite_backup_file" | cut -f1)
log "Copy complete (${elapsed}s, size: ${sqlite_backup_size})"

# ── Phase 7: re-enable background processing and restart Neo4j ────────────────
log "Re-enabling background processing and restarting Neo4j..."
kubectl set env deployment/"${APP_DEP}" -n "${NS}" DISABLE_BACKGROUND_PROCESSING=false >&2
kubectl scale deployment/"${NEO4J_DEP}" -n "${NS}" --replicas=1 >&2
restored=1   # cluster is back to normal — the trap must not redo this
kubectl rollout status deployment/"${APP_DEP}" -n "${NS}" --timeout=120s >&2

# ── Phase 8: compress both files with zstd ───────────────────────────────────
neo4j_backup_file_zst=$(compress_and_report "$neo4j_backup_file" "Neo4j backup")
neo4j_compressed_size=$(du -sh "$neo4j_backup_file_zst" | cut -f1)

sqlite_backup_file_zst=$(compress_and_report "$sqlite_backup_file" "SQLite backup")
sqlite_compressed_size=$(du -sh "$sqlite_backup_file_zst" | cut -f1)

# ── Phase 9: upload both to Azure ─────────────────────────────────────────────
upload_to_azure "$neo4j_backup_file_zst" "Neo4j backup"
upload_to_azure "$sqlite_backup_file_zst" "SQLite backup"

echo "" >&2
log "✓ Both backups complete and uploaded to Azure"
log "Neo4j file: $(basename "$neo4j_backup_file_zst") (${neo4j_compressed_size})"
log "SQLite file: $(basename "$sqlite_backup_file_zst") (${sqlite_compressed_size})"
echo "" >&2

# ── Phase 10: carve + publish the E2E seed DB ─────────────────────────────────
# Deliberately last: Azure already has both archives, so anything that goes
# wrong from here costs a CI fixture refresh, never a backup. Runs in a subshell
# so its own `return 1` paths can't unwind the run above.
seed_status=skipped
if [ -n "${E2E_GH_TOKEN:-}" ]; then
  e2e_dir="${BACKUP_DIR}/e2e"
  fixture="${e2e_dir}/template.db"
  mkdir -p "$e2e_dir"

  if (
    install_gh
    build_e2e_fixture "$sqlite_backup_file" "$fixture"
    publish_e2e_fixture "$fixture" "${E2E_GH_REPO:-sila-skandia/bfstats}"
  ); then
    seed_status=published
  else
    seed_status=failed
  fi
  echo "" >&2
else
  log "E2E_GH_TOKEN not set — skipping the seed DB"
fi

case "$seed_status" in
  published) log "✓ Seed DB published to ${E2E_GH_REPO:-sila-skandia/bfstats} (release e2e-fixture)" ;;
  failed)    log "✗ Seed DB FAILED — the Azure backups above are complete and unaffected." >&2
             log "  CI keeps running against the previously published fixture until this succeeds." >&2 ;;
esac
echo "" >&2

[ "$seed_status" != "failed" ]

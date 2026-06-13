# Media cleanup — Radarr/Sonarr/Plex disk triage

Scope: `api/src/media/`, `config/media.yaml`, and the UI in `ui/src/media/`.
Root `CLAUDE.md` has the summary; this is the contract.

A "should I delete this?" view: everything the arrs have **on disk** (items
with `sizeOnDisk > 0` only), joined with Plex watch state and ratings, so
"87 GB · never watched · 5.2" is an easy delete. Deletes are **arr-managed**
(the arrs own the files — never `rm` behind their back).

## Config (`config/media.yaml` + `media.config.ts`)

```yaml
radarr: { url: ..., apiKey: ... }   # see config/media.yaml — NB the real file
sonarr: { url: ..., apiKey: ... }   # must use BLOCK style: `${VAR}` is invalid
plex:   { url: ..., token: ... }    # YAML inside flow maps `{ ... }`
```

- **Deliberate divergence from servers.loader:** an unset `${VAR}` does NOT
  fail boot. `expandEnv`'s throw is caught per service, which disables *just
  that service* with a one-time warning (`warnOnce` — config re-loads per
  request, don't spam). A server's missing secret is fatal because every
  route depends on it; media is auxiliary (see root Conventions).
- Each service is independently optional: sonarr-only ⇒ TV-only view; no plex
  ⇒ "no plex data" badges everywhere. `enabled = radarr || sonarr` (plex alone
  has nothing to list). All three off ⇒ `/api/media` 503s and the UI hides the
  view (`useMediaStatus`, exact `useAiStatus` pattern).
- Config is re-read per request — a `.env`/yaml edit applies on the next
  refresh, no restart.

## Snapshot cache (`media.aggregate.ts`)

In-memory only, by design (no DB / clone-and-go): module-level snapshot +
**15-min TTL** + **single-flight** (concurrent GETs share one in-flight pull).
`POST /api/media/refresh` forces.

- Refresh pulls all three services via `Promise.allSettled`; a failing service
  becomes `state:'error'` and **carries forward its items from the last good
  snapshot** (stale beats blank for triage). A *disabled* service shows empty,
  not stale — carry-forward is for transient errors only.
- Plex section pulls can be MBs of JSON on a big library — transient per
  refresh, mapped into small lookup maps and dropped; never cache the raw
  payloads. Per-season watch state comes from ONE episode-level `?type=4`
  section query aggregated client-side (the `?type=3` season listing on
  current PMS carries no leafCount/viewedLeafCount) — **never per-show
  children calls** (N+1 over HTTP).
- **Join keys:** movies on `tmdbId` (fallback `imdbId`); series on `tvdbId`;
  seasons via show `ratingKey` + season `index` ↔ `seasonNumber` (0 = specials
  in both systems). Unmatched ⇒ `plex: null` ⇒ "no plex data" badge — never an
  error, and the UI's "never watched" filter includes these (the FOMO case
  must stay visible).
- After a successful delete, `applyDelete` mutates the cache optimistically
  (row gone / season zeroed) then kicks a fire-and-forget background refresh.

## Deletes (routes + `sonarr.client.ts` / `radarr.client.ts`)

- Every DELETE route requires `confirm: true` in the JSON body — server-side
  backstop behind the UI's ConfirmDialog; without it ⇒ 400, nothing happens.
- Movie: `DELETE /api/v3/movie/{id}?deleteFiles=true&addImportExclusion={bool}`
  (the UI's "also block re-add" checkbox). Series:
  `DELETE /api/v3/series/{id}?deleteFiles=true`.
- **Season delete is a composite** (Sonarr has no endpoint for it) with an
  ordering invariant: (1) unmonitor the season via series PUT **first** so
  Sonarr doesn't re-grab while files vanish, (2) then bulk-delete that
  season's files (`DELETE /api/v3/episodefile/bulk`). Keep that order.
- Upstream failure ⇒ 502 `{ok:false, error}` passed through to the UI inline.

## Gotchas

- **Sonarr ratings are a single tvdb `ratings.value`** — there is no RT/IMDb
  for TV; don't promise those columns. Radarr has the full set
  (imdb/tmdb/rt/metacritic), flattened to values server-side.
- **Genres come from the *arrs** (`genres[]` on both the Radarr movie and Sonarr
  series resource), so they survive a Plex-less checkout. Shown in the detail
  views + each list row, and filterable via the genre `<select>` in
  `MediaView` (`collectGenres`/`matchesGenre` in `mediaSelect.ts`).
- **Poster art = the arr image's `remoteUrl`** (a public TMDB/thetvdb CDN link),
  mapped to `poster` by `posterUrl()` and shown only in the detail view. The
  arr-local `images[].url` needs the arr API key + reachability, so we never use
  it — the browser loads `remoteUrl` straight from the CDN (consistent with
  "browsers never hit the arrs directly"). The `<Poster>` component hides itself
  on a load error, so a dead URL degrades to no image, never a broken glyph.
- **No actors/cast — by design.** Neither arr carries credits, and Plex only
  exposes the `Role` tag via the per-item `/library/metadata/{key}` call. The
  bulk `/library/sections/{key}/all` listing we pull carries `Genre` inline but
  **not** `Role`/`Director`/`Writer`. Fetching cast would mean one request per
  title (N+1 over HTTP) — the exact pattern this feature forbids — so the view
  intentionally has no actor column. Don't add per-item Plex metadata calls.
- Plex auth is `X-Plex-Token` + `Accept: application/json` (XML otherwise);
  the loader normalises the YAML's `token:` into `apiKey` internally.
- Both shells render the same `MediaView`/`SeriesDetail` (`.m-app .media`
  palette remap). Desktop opens series detail inline (Dashboard/NodeDetail
  precedent); mobile routes to `/m/media/series/:id` via the `onOpenSeries`
  prop — presentation differs, the `useMedia` hook is shared, never forked.
- The mobile tab bar class is **count-derived** in `TabBar.tsx` (media's tab
  is gated) — `.m-tabbar.five` exists in theme.css; don't hard-code the count.

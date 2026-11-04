# Runbook: Deploy Vaultwarden custom web vault + extension (1Password-style item share)

**Audience:** an autonomous agent (OpenClaw) with shell access to the server running Vaultwarden.
**Goal:** put the custom web vault (1-click item share) live on `https://vaultwarden.aiwind.online`, verify it end to end, and set up automatic weekly rebuilds.

Work through the phases in order. Each phase has a **check** step: do not start the next phase until its check passes. If any step under **STOP conditions** happens, stop and report to the user. Do not improvise around it.

---

## 0. Facts (as of 2026-11-04)

| Item | Value |
|---|---|
| Public URL | `https://vaultwarden.aiwind.online` |
| Current live web vault | `2026.7.0` (Vaultwarden server `1.37.3` or `1.37.4`) |
| Custom build | web vault `2026.10.1` + patch "1password-item-share" |
| Matching Vaultwarden server | **`vaultwarden/server:1.37.5`** (upstream pairs `1.37.5` with web vault `v2026.10.1`) |
| Source repo (fork) | `https://github.com/wind7vn/vw_web_builds`, branch `custom-1password-share` |
| Release with build artifacts | `https://github.com/wind7vn/vw_web_builds/releases/tag/custom-2026.10.1` |
| Web vault artifact | `bw_web_vault.tar.gz` (≈41.8 MB, unpacks to `web-vault/`) |
| Extension artifact | `browser-chrome-2026.10.1.zip` (≈25.7 MB, Chrome/Edge/Brave MV3, unpacked) |
| Build host (already has a working checkout + node_modules) | `/root/projects/vw_web_builds` on the Hermes machine |

Direct download URLs:
```
https://github.com/wind7vn/vw_web_builds/releases/download/custom-2026.10.1/bw_web_vault.tar.gz
https://github.com/wind7vn/vw_web_builds/releases/download/custom-2026.10.1/browser-chrome-2026.10.1.zip
```

### How the feature works (enough to debug it)
- Uses Bitwarden's built-in `@bitwarden/share` (item share via link). The patch removes the feature-flag and premium checks, plus the forced email OTP that Vaultwarden does not support.
- Vaultwarden's API only accepts Send types Text (0) and File (1). The client therefore sends a shared item as an end-to-end-encrypted **Text Send** whose plaintext is a JSON envelope `{"__vw_item_share":1,"cipher":...}`. The receiving page `/#/send/...` detects the envelope and renders an item card with Copy Username / Copy Password / Open website buttons.
- **The Vaultwarden server binary is not modified.** Only the `/web-vault` static files are replaced.
- Consequence: the share UI exists only in the custom web vault and the custom extension. Stock Bitwarden clients show these Sends as a Text Send containing raw JSON. That is expected, not a bug.

---

## Safety rules (always)
1. **Back up before you change anything** (Phase 1). Never delete or overwrite `/data` (the Vaultwarden data dir: `db.sqlite3`, `rsa_key*`, `attachments/`, `sends/`, `config.json`).
2. Never print, log or copy secrets: `ADMIN_TOKEN`, contents of `.env`, `rsa_key.pem`, user passwords, Send links that contain real credentials.
3. Mount the web vault **read-only** (`:ro`).
4. Pin the image tag (`vaultwarden/server:1.37.5`). Do **not** use `latest`: the custom web vault must match the server version.
5. Use only test data for end-to-end tests (Phase 4). Never share real vault items.

## STOP conditions (report to the user, do not work around)
- You cannot find the Vaultwarden container, or it is not run by Docker or docker compose (e.g. a bare binary or systemd service). Report what you found.
- The backup fails or the backup file is empty.
- After the upgrade, `/alive` does not return 200 within 2 minutes, or the logs show DB migration errors. Roll back (Phase 7).
- `sha256sum` of the downloaded artifact differs from the release asset digest (Phase 2).
- The user's account must be used for login and no test account/credentials were given. Ask, do not guess.

---

## Phase 1: Discover and back up

```bash
# 1a. Find the container
docker ps --format '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Ports}}' | grep -i -E 'vaultwarden|bitwarden'
CID=<container id or name>

# 1b. Find compose project + data mount
docker inspect "$CID" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
docker inspect "$CID" --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}'
docker inspect "$CID" --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Mode}}){{"\n"}}{{end}}'
docker inspect "$CID" --format '{{.Config.Image}}'
docker exec "$CID" cat /web-vault/version.json   # expect 2026.7.0
```
Record the values: `COMPOSE_DIR`, `COMPOSE_FILE`, `DATA_DIR` (host path mounted at `/data`), current image.

```bash
# 1c. Backup (SQLite-consistent). Run inside COMPOSE_DIR.
TS=$(date +%Y%m%d-%H%M%S)
BK=/opt/vaultwarden-backups/$TS
mkdir -p "$BK"
cp -a "$COMPOSE_FILE" "$BK/"
[ -f .env ] && cp -a .env "$BK/"                      # do not print it
docker exec "$CID" sh -c 'command -v sqlite3' >/dev/null 2>&1 \
  && docker exec "$CID" sqlite3 /data/db.sqlite3 ".backup '/data/db-backup-$TS.sqlite3'" \
  && mv "$DATA_DIR/db-backup-$TS.sqlite3" "$BK/"
# Fallback / plus full copy (brief stop guarantees consistency):
docker compose stop vaultwarden
tar -czf "$BK/vw-data.tar.gz" -C "$DATA_DIR" .
docker compose start vaultwarden
ls -lh "$BK"
```
If the database is PostgreSQL or MySQL (`DATABASE_URL` set) instead of SQLite, dump it with `pg_dump` / `mysqldump` into `$BK` instead.

**Check:** `$BK/vw-data.tar.gz` exists and is larger than 0 bytes; `tar -tzf "$BK/vw-data.tar.gz" | grep db.sqlite3` matches (SQLite case). Note: the service name in compose may not be `vaultwarden`; use the real service name from the compose file.

---

## Phase 2: Fetch the custom web vault

```bash
mkdir -p /opt/vaultwarden-custom && cd /opt/vaultwarden-custom
curl -fL -o bw_web_vault.tar.gz \
  https://github.com/wind7vn/vw_web_builds/releases/download/custom-2026.10.1/bw_web_vault.tar.gz
# Verify against the digest GitHub reports for the asset:
curl -s https://api.github.com/repos/wind7vn/vw_web_builds/releases/tags/custom-2026.10.1 \
  | grep -A2 '"name": "bw_web_vault.tar.gz"' ; sha256sum bw_web_vault.tar.gz
# (If the API shows "digest": "sha256:...", it must equal the sha256sum output.)
rm -rf web-vault.new && mkdir web-vault.new && tar -xzf bw_web_vault.tar.gz -C web-vault.new --strip-components=1
cat web-vault.new/version.json        # expect {"version":"2026.10.1"} (or similar)
cat web-vault.new/vw-version.json     # expect 2026.10.1-1p-share
grep -l vw_item_share web-vault.new/app/main.*.js   # must print one file
[ -d web-vault ] && mv web-vault "web-vault.prev-$(date +%s)"
mv web-vault.new web-vault
```
Ownership: files must be readable by the container user (`chmod -R a+rX /opt/vaultwarden-custom/web-vault`).

**Check:** `grep -l vw_item_share /opt/vaultwarden-custom/web-vault/app/main.*.js` prints a file.

---

## Phase 3: Upgrade server to 1.37.5 and mount the custom web vault

Edit `$COMPOSE_FILE` for the Vaultwarden service. Change **only** these keys:
```yaml
services:
  vaultwarden:                      # use the real service name
    image: vaultwarden/server:1.37.5
    volumes:
      - <existing DATA_DIR>:/data   # keep exactly as is
      - /opt/vaultwarden-custom/web-vault:/web-vault:ro
    environment:
      - WEB_VAULT_ENABLED=true      # only if not already set; do not touch other vars
```
Then:
```bash
cd "$COMPOSE_DIR"
docker compose config >/dev/null          # syntax check
docker compose pull vaultwarden
docker compose up -d vaultwarden
sleep 10; docker compose logs --tail=80 vaultwarden
```

**Check (all must pass):**
```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://vaultwarden.aiwind.online/alive         # 200
curl -fsS https://vaultwarden.aiwind.online/api/config | head -c 200; echo                  # JSON with "server":{"name":"Vaultwarden"...}
curl -fsS https://vaultwarden.aiwind.online/version.json                                   # 2026.10.1
curl -fsS https://vaultwarden.aiwind.online/vw-version.json                                # 2026.10.1-1p-share
```
If a reverse proxy or CDN caches static files, purge it or check with `?nocache=$RANDOM`.
If anything fails, go to Phase 7 (rollback).

---

## Phase 4: End-to-end functional test (browser)

Needs a **test account** on this server (ask the user for one, or create one if signups are enabled and the user agrees). Use a browser automation tool or ask the user to do the clicks. Steps:

1. Log in at `https://vaultwarden.aiwind.online`. Hard-refresh (Ctrl+Shift+R) to drop the old cached web vault.
2. Create a Login item named `share-test`: username `alice@test.local`, password `Test-Only-123!`, URL `https://example.com`.
3. In the vault list, open the item's **⋮** menu. Expect **Share via link** and **Copy link (24h)** entries. Click **Copy link (24h)**. Expect a toast saying the link was copied, and the clipboard holds a URL like `https://vaultwarden.aiwind.online/#/send/<id>/<key>`.
4. Open the item view. Expect a **Share** button; open it and check the form shows *Anyone with the link* / optional password / expiry (1h, 1d, 7d, 30d) / *One-time view*. Create a second link with **One-time view** turned on.
5. In a **private window** (not logged in), open link #1. Expect: an item card with badge "E2EE Shared Item", title `share-test`, and **Copy Username**, **Copy Password**, **Launch Website** buttons. Below it, the full item view. Clicking Copy Password copies `Test-Only-123!`.
6. Open link #2 (one-time) twice. The first open works; the second must show that the Send is unavailable or expired.
7. In the logged-in window, go to **Send**. Both links must be listed and deletable. Delete them, then delete the `share-test` item.

**Expected failure modes and what they mean**
| Symptom | Likely cause |
|---|---|
| No share menu entries | Old web vault cached by the browser, CDN or proxy; or `/web-vault` mount not applied (`docker exec $CID cat /web-vault/vw-version.json`) |
| "Invalid Send type" error | The patch is not active in this client (stock web vault or extension) |
| "Sends with email verification is not supported" | Email auth path still active, i.e. an unpatched client |
| Recipient page shows raw JSON | Link opened in a stock (non-custom) web vault |
| Send disabled / policy error | Org policy "Disable Send" or `SENDS_ALLOWED=false` in the server env |

---

## Phase 5: Browser extension (on the user's own computer)

The agent cannot install it on the user's computer unless it controls that machine. Give the user these steps:
1. Download `browser-chrome-2026.10.1.zip` from the release and unzip it to a **permanent** folder (Chrome loads the extension from that folder, so it must not be deleted).
2. Go to `chrome://extensions` (or `edge://extensions`, `brave://extensions`), turn on **Developer mode**, click **Load unpacked**, and select the folder.
3. Remove or disable the official Bitwarden extension so the two don't conflict on autofill.
4. In the extension: region **Self-hosted**, server URL `https://vaultwarden.aiwind.online`, then log in.
5. Test: on an item, ⋮ → **Share via link** / **Copy link (24h)**; the item view has a **Share** button below Autofill.

Notes: unpacked extensions do **not** auto-update. After each new release, unzip it over the same folder and click ↻ on the extension card. Chrome may show a "developer mode extensions" warning at startup; that is expected.

---

## Phase 6: Automatic rebuilds (pick one)

The script `scripts/sync-and-build.sh` (branch `custom-1password-share`) does the following:
1. Gets the latest upstream tag from `vaultwarden/vw_web_builds`. If that tag is already built, it exits immediately (use `--force` to rebuild anyway).
2. Re-creates the branch from that tag, reverts upstream's "remove other clients" commit (which restores `apps/browser`), and applies `patches/1password-item-share.patch`. If the patch no longer applies, it **exits with code 2** and builds nothing.
3. Runs `npm ci` when `package-lock.json` changed, then builds the web vault and the Chrome extension into `dist/`.
4. With `--release`: force-pushes the branch and creates or updates the GitHub release `custom-<version>`.

Flags: `--force` `--release` `--current` (build the working tree, no upstream sync) `--web-only` `--browser-only` `--resync` `--prepare-only` (sync and patch only, no build). Env vars: `VW_SYNC_TAG=<tag>` (pin a tag), `VW_SYNC_BRANCH=<name>`.
Build needs: Node 22, about 8 GB of free RAM, about 10 minutes.

**Option A: cron on the build host (recommended; already has deps + gh auth):**
```bash
( crontab -l 2>/dev/null; echo '0 3 * * 1 cd /root/projects/vw_web_builds && ./scripts/sync-and-build.sh --release >> /var/log/vw-sync-build.log 2>&1' ) | crontab -
```
**Option B: GitHub Actions:** the workflow `.github/workflows/build-custom-share.yml` only runs if it is on the **default branch**. The fork's current default branch is `readme`, so the workflow is inactive. Enable it with:
```bash
gh repo edit wind7vn/vw_web_builds --default-branch custom-1password-share
gh workflow list -R wind7vn/vw_web_builds          # must list the custom workflow
gh workflow run build-custom-share.yml -R wind7vn/vw_web_builds -f force_rebuild=true
```
Optionally disable upstream's unrelated workflow: `gh workflow disable "Build Web" -R wind7vn/vw_web_builds`.

**Deploying a new release is a separate step (do not automate blindly).** A new web vault usually needs a newer Vaultwarden server. Before you deploy release `custom-X`:
1. Check that the matching Vaultwarden release pins the same web vault: `curl -s https://raw.githubusercontent.com/dani-garcia/vaultwarden/<server-tag>/docker/DockerSettings.yaml | grep vault_version`.
2. Back up (Phase 1), set the image to that server tag, replace `web-vault` (Phase 2), restart (Phase 3), then run the check (Phase 3) and the end-to-end test (Phase 4).
3. Tell the user to update the extension folder (Phase 5).

---

## Phase 7: Rollback

```bash
cd "$COMPOSE_DIR"
cp "$BK/$(basename "$COMPOSE_FILE")" "$COMPOSE_FILE"     # restores the old image tag + mounts
docker compose up -d vaultwarden
curl -fsS https://vaultwarden.aiwind.online/version.json  # back to 2026.7.0
```
Restore the database **only** if a migration broke it (the server refuses to start). The newer server may already have migrated the DB, and older servers cannot always read a migrated DB:
```bash
docker compose stop vaultwarden
mv "$DATA_DIR" "${DATA_DIR}.broken-$(date +%s)" && mkdir -p "$DATA_DIR"
tar -xzf "$BK/vw-data.tar.gz" -C "$DATA_DIR"
docker compose up -d vaultwarden
```

---

## Final report to the user
Report: the backup path; old → new image tag; outputs of `version.json`, `vw-version.json` and `/alive`; pass/fail for each step in Phase 4; which auto-rebuild option was set up; anything skipped or stopped, and why.

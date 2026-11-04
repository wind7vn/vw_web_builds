#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Vaultwarden Custom Web Vault + Browser Extension Sync & Build Script
# Features:
#  - Restores apps/browser from upstream vaultwarden/vw_web_builds
#  - Applies 1Password-style 1-Click Item Share patch (Web Vault + Extension)
#  - Builds Web Vault (dist/bw_web_vault.tar.gz + dist/web-vault/)
#  - Builds Chrome/Brave/Edge MV3 Extension (dist/browser-chrome-<ver>.zip)
#  - Optional: publishes artifacts to GitHub Releases (--release)
# ==============================================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PATCH_FILE="$REPO_ROOT/patches/1password-item-share.patch"
DIST_DIR="$REPO_ROOT/dist"
STATE_FILE="$DIST_DIR/.last_built_tag"

FORCE=false
CURRENT_ONLY=false
PUBLISH_RELEASE=false
SKIP_WEB=false
SKIP_BROWSER=false

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --current) CURRENT_ONLY=true ;;
    --release) PUBLISH_RELEASE=true ;;
    --web-only) SKIP_BROWSER=true ;;
    --browser-only) SKIP_WEB=true ;;
    *)
      echo "Unknown option: $arg"
      echo "Usage: $0 [--current] [--force] [--release] [--web-only] [--browser-only]"
      exit 1
      ;;
  esac
done

mkdir -p "$DIST_DIR"

if [ "$CURRENT_ONLY" = false ]; then
  echo "[1/6] Checking latest tag from vaultwarden/vw_web_builds..."
  LATEST_TAG=$(git ls-remote --tags --refs --sort="-v:refname" https://github.com/vaultwarden/vw_web_builds.git | head -n1 | awk -F/ '{print $NF}')
  if [ -z "$LATEST_TAG" ]; then
    echo "Error: Could not determine latest upstream tag."
    exit 1
  fi
  echo " -> Latest upstream tag: $LATEST_TAG"

  if [ "$FORCE" = false ] && [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE")" = "$LATEST_TAG" ]; then
    echo " -> Already built $LATEST_TAG. Use --force to rebuild."
    exit 0
  fi

  CURRENT_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
  if [ "$CURRENT_TAG" != "$LATEST_TAG" ] && [ "${ CURRENT_TAG%+0}" != "${LATEST_TAG%+0}" ]; then
    echo "[2/6] Fetching upstream tag $LATEST_TAG..."
    git remote add upstream https://github.com/vaultwarden/vw_web_builds.git 2>/dev/null || true
    git fetch --depth=10 upstream "refs/tags/$LATEST_TAG:refs/tags/$LATEST_TAG"
    git checkout -B "custom-${LATEST_TAG}" "refs/tags/$LATEST_TAG"

    REMOVE_CLIENTS_SHA=$(git log -n 10 --grep="remove other clients" --format="%H" | head -n1)
    if [ -n "$REMOVE_CLIENTS_SHA" ]; then
      echo " -> Reverting commit $REMOVE_CLIENTS_SHA ('remove other clients') to restore apps/browser..."
      git revert --no-edit "$REMOVE_CLIENTS_SHA"
    fi

    if [ -f "$PATCH_FILE" ]; then
      echo " -> Applying 1Password Item Share patch ($PATCH_FILE)..."
      git apply --3way "$PATCH_FILE"
      git commit -am "feat(share): enable 1Password-style 1-click item sharing for Vaultwarden"
    fi
  fi
else
  LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "custom")
  echo "[1/6] Building from current working tree ($LATEST_TAG)..."
fi

CLEAN_VERSION="${LATEST_TAG#v}"
CLEAN_VERSION="${CLEAN_VERSION%+*}"

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "[3/6] Installing monorepo dependencies (npm ci)..."
  npm ci --ignore-scripts --no-audit --no-fund
else
  echo "[3/6] node_modules already present, skipping npm ci."
fi

export NODE_OPTIONS="--max-old-space-size=8192"

if [ "$SKIP_WEB" = false ]; then
  echo "[4/6] Building Vaultwarden Web Vault (apps/web)..."
  npm run dist:oss:selfhost --workspace @bitwarden/web-vault

  echo " -> Packaging dist/web-vault and dist/bw_web_vault.tar.gz..."
  rm -rf "$DIST_DIR/web-vault" "$DIST_DIR/bw_web_vault.tar.gz"
  cp -R "$REPO_ROOT/apps/web/build" "$DIST_DIR/web-vault"
  printf '{"version":"%s-1p-share"}\n' "$CLEAN_VERSION" > "$DIST_DIR/web-vault/vw-version.json"
  tar -czf "$DIST_DIR/bw_web_vault.tar.gz" -C "$DIST_DIR" web-vault
  echo " -> Web Vault ready: $DIST_DIR/bw_web_vault.tar.gz ($(du -h "$DIST_DIR/bw_web_vault.tar.gz" | cut -f1))"
fi

if [ "$SKIP_BROWSER" = false ]; then
  echo "[5/6] Building Browser Extension for Chrome/Brave/Edge (apps/browser)..."
  npm run build:prod:chrome --workspace @bitwarden/browser

  echo " -> Packaging dist/browser-chrome-${CLEAN_VERSION}.zip..."
  rm -rf "$DIST_DIR/browser-unpacked" "$DIST_DIR/browser-chrome-${CLEAN_VERSION}.zip" "$DIST_DIR/browser-chrome-latest.zip"
  cp -R "$REPO_ROOT/apps/browser/build" "$DIST_DIR/browser-unpacked"
  (
    cd "$REPO_ROOT/apps/browser/build"
    python3 -c '
import os, zipfile, sys
out_path = sys.argv[1]
with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk("."):
        for file in files:
            full = os.path.join(root, file)
            rel = os.path.relpath(full, ".")
            zf.write(full, rel)
' "$DIST_DIR/browser-chrome-${CLEAN_VERSION}.zip"
  )
  cp "$DIST_DIR/browser-chrome-${CLEAN_VERSION}.zip" "$DIST_DIR/browser-chrome-latest.zip"
  echo " -> Browser Extension ready: $DIST_DIR/browser-chrome-${CLEAN_VERSION}.zip ($(du -h "$DIST_DIR/browser-chrome-${CLEAN_VERSION}.zip" | cut -f1))"
fi

echo "$LATEST_TAG" > "$STATE_FILE"

if [ "$PUBLISH_RELEASE" = true ]; then
  GH_REPO="${GH_REPO:-wind7vn/vw_web_builds}"
  echo "[6/6] Publishing release artifacts to GitHub ($GH_REPO)..."
  RELEASE_TAG="custom-${CLEAN_VERSION}"
  ASSETS=()
  [ -f "$DIST_DIR/bw_web_vault.tar.gz" ] && ASSETS+=("$DIST_DIR/bw_web_vault.tar.gz")
  [ -f "$DIST_DIR/browser-chrome-${CLEAN_VERSION}.zip" ] && ASSETS+=("$DIST_DIR/browser-chrome-${CLEAN_VERSION}.zip")
  if gh release view "$RELEASE_TAG" --repo "$GH_REPO" >/dev/null 2>&1; then
    gh release upload "$RELEASE_TAG" "${ASSETS[@]}" --repo "$GH_REPO" --clobber
  else
    gh release create "$RELEASE_TAG" "${ASSETS[@]}" \
      --repo "$GH_REPO" \
      --target "$(git rev-parse HEAD)" \
      --title "Vaultwarden Custom Web Vault + Extension (${CLEAN_VERSION} + 1Password Share)" \
      --notes "Automated build of Vaultwarden Web Vault (\`bw_web_vault.tar.gz\`) and Chrome/Edge/Brave MV3 Browser Extension (\`browser-chrome-${CLEAN_VERSION}.zip\`) with 1Password-style 1-Click Item Sharing."
  fi
fi

echo "✅ Build completed successfully! Artifacts in: $DIST_DIR"

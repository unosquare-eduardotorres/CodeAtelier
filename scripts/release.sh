#!/bin/bash
# Cut a release: bump once, build every platform at that version, verify both
# update channels advertise it, then record it in git.
#
# Why this script exists
# ----------------------
# The patch bump used to live inside build-mac.sh, which made the version a
# side effect of building one platform. Two things went wrong, repeatedly:
#
#   1. `build:mac` alone advanced the version and published only the mac
#      channel. `latest.yml` kept describing the previous version, so every
#      Windows client was offered a stale build indefinitely.
#   2. Rebuilding to debug bumped the version again. 1.0.72 and 1.0.79 were
#      built, shipped and never committed — the numbers exist in dist/ and in
#      nobody's git history.
#
# So: exactly one bump per release, both platforms built from it, and the
# version is only committed once the artifacts it names actually exist and
# both channels point at them. A failed release leaves the version where it
# started rather than burning a number.
#
# Usage:
#   npm run build:release              # patch bump (default)
#   RELEASE_TYPE=minor npm run build:release
#   ALLOW_DIRTY=1 npm run build:release   # build without committing or tagging
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RELEASE_TYPE="${RELEASE_TYPE:-patch}"
OLD_VERSION="$(node -p "require('./package.json').version")"
NEW_VERSION=""
BUMPED=false
RELEASE_OK=false

# ── Resolve the OneDrive feed directory
# Duplicated from publish-to-onedrive.sh on purpose: both scripts have to work
# standalone, and this one must not depend on the other having been sourced.
ONEDRIVE_DIR="${ONEDRIVE_DIR:-}"
if [ -z "$ONEDRIVE_DIR" ]; then
  for candidate in "$HOME/Library/CloudStorage/OneDrive"*/Code\ Atelier; do
    if [ -d "$candidate" ]; then
      ONEDRIVE_DIR="$candidate"
      break
    fi
  done
fi

yml_version() {
  grep -m1 '^version:' "$1" 2>/dev/null \
    | sed -e 's/^version:[[:space:]]*//' -e "s/^['\"]//" -e "s/['\"]\$//" -e 's/[[:space:]]*$//'
}

# ── Revert the bump unless the release completed
# Without this, a build that dies half way leaves package.json claiming a
# version that was never released — which is how 1.0.72 and 1.0.79 happened.
restore_version() {
  if [ "$BUMPED" = true ] && [ "$RELEASE_OK" != true ]; then
    echo ""
    echo "▸ Release did not complete — reverting version to ${OLD_VERSION}"
    npm version "$OLD_VERSION" --no-git-tag-version --allow-same-version >/dev/null 2>&1 || true
    echo "  package.json back at ${OLD_VERSION} (no version number burned)"
  fi
}
trap restore_version EXIT

# ── Step 0: Working tree must be clean
# The tag this script writes claims "this commit produced these artifacts". On
# a dirty tree that claim is false, so either the tree is clean or the release
# is explicitly untagged.
DIRTY="$(git status --porcelain 2>/dev/null || true)"
SKIP_GIT=false
if [ -n "$DIRTY" ]; then
  if [ "${ALLOW_DIRTY:-}" = "1" ]; then
    echo "⚠ Working tree is dirty and ALLOW_DIRTY=1 is set."
    echo "  Building anyway, but this release will NOT be committed or tagged —"
    echo "  a tag on a dirty tree would not describe what actually shipped."
    SKIP_GIT=true
  else
    echo "❌ Working tree is not clean — refusing to cut a release."
    echo ""
    echo "$DIRTY" | head -20
    echo ""
    echo "  Commit (or stash) first, so the tag names the commit that built these"
    echo "  artifacts. To build without recording a release:"
    echo "     ALLOW_DIRTY=1 npm run build:release"
    exit 1
  fi
fi

# ── Step 1: The one bump
echo "▸ Step 1: Bump version (${RELEASE_TYPE})"
npm version "$RELEASE_TYPE" --no-git-tag-version >/dev/null
BUMPED=true
NEW_VERSION="$(node -p "require('./package.json').version")"
echo "  ${OLD_VERSION} → ${NEW_VERSION}"

# ── Step 2: Build every platform at that version
# Sequential, not parallel: both scripts mutate node_modules and package.json
# and guard against each other with a lock file.
echo ""
echo "▸ Step 2: Build macOS"
bash "$ROOT/scripts/build-mac.sh"

echo ""
echo "▸ Step 3: Build Windows"
bash "$ROOT/scripts/build-win.sh"

# ── Step 4: Both channels must advertise this release
# The per-platform publish already warns about a stale channel, but a warning
# at the end of a 20-minute build scrolls past. Here it is fatal: a release is
# not a release until every platform can actually be offered it.
echo ""
echo "▸ Step 4: Verify update channels"
if [ -z "$ONEDRIVE_DIR" ]; then
  echo "  ⚠ OneDrive folder not found — channels not verified."
  echo "    Artifacts are in dist/ but nothing was published."
else
  CHANNEL_FAIL=0
  for entry in "latest-mac.yml:macOS" "latest.yml:Windows"; do
    channel="${entry%%:*}"
    label="${entry##*:}"
    found="$(yml_version "$ONEDRIVE_DIR/$channel")"
    if [ "$found" = "$NEW_VERSION" ]; then
      echo "    ✓ ${label}: v${found}"
    else
      echo "    ❌ ${label}: v${found:-missing} — expected v${NEW_VERSION}"
      CHANNEL_FAIL=$((CHANNEL_FAIL + 1))
    fi
  done
  if [ "$CHANNEL_FAIL" -gt 0 ]; then
    echo ""
    echo "  ❌ ${CHANNEL_FAIL} channel(s) not on v${NEW_VERSION} — release incomplete."
    echo "     The artifacts exist; the feed does not point at them."
    exit 1
  fi
fi

# ── Step 5: Record the release
RELEASE_OK=true

if [ "$SKIP_GIT" = true ]; then
  echo ""
  echo "▸ Step 5: Skipped commit + tag (ALLOW_DIRTY=1)"
  echo "  v${NEW_VERSION} is published but not recorded in git."
else
  echo ""
  echo "▸ Step 5: Record release in git"
  git add package.json package-lock.json
  git commit -m "chore(release): v${NEW_VERSION}" >/dev/null
  git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"
  echo "  Committed and tagged v${NEW_VERSION}"
  echo "  Not pushed — review, then: git push && git push origin v${NEW_VERSION}"
fi

echo ""
echo "✅ Released v${NEW_VERSION} on macOS + Windows"
if [ -n "$ONEDRIVE_DIR" ]; then
  echo "   📁 ${ONEDRIVE_DIR}/${NEW_VERSION}/{mac,win}/"
  echo ""
  echo "   Note: a local copy into OneDrive is not delivery. Confirm a consuming"
  echo "   machine sees v${NEW_VERSION} before telling anyone it shipped."
fi

#!/bin/bash
# Publish build artifacts to OneDrive for auto-update distribution.
# Called automatically at the end of build-mac.sh / build-win.sh.
# Can also be run standalone: ./scripts/publish-to-onedrive.sh
#
# Safe to run twice — the manifest rewrite is idempotent and every publish ends
# with a verification pass that fails the step rather than leaving a feed that
# points at files which do not exist.
#
# Ordering matters and is deliberate:
#   copy artifacts -> stage the manifest -> verify every reference -> publish it
# The manifest is the LAST thing to become visible, because it is the thing
# clients act on. Verifying *after* publishing (as this script used to) left a
# poisoned feed behind whenever verification failed: the build went red, but the
# manifest was already live and every Windows client 404'd on download until
# someone noticed and republished.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Resolve OneDrive path
# Honour a pre-set ONEDRIVE_DIR so the script works against a differently-named
# tenant folder (and so a dry run can point it at a scratch directory).
ONEDRIVE_DIR="${ONEDRIVE_DIR:-}"
if [ -z "$ONEDRIVE_DIR" ]; then
  for candidate in "$HOME/Library/CloudStorage/OneDrive"*/Code\ Atelier; do
    if [ -d "$candidate" ]; then
      ONEDRIVE_DIR="$candidate"
      break
    fi
  done
fi

if [ -z "$ONEDRIVE_DIR" ]; then
  echo "⚠ OneDrive 'Code Atelier' folder not found — skipping publish"
  echo "  Expected at: ~/Library/CloudStorage/OneDrive-*/Code Atelier"
  exit 0  # Non-fatal — build still succeeded
fi

echo ""
echo "▸ Publishing artifacts to OneDrive: $ONEDRIVE_DIR"

VERSION=$(node -e "console.log(require('./package.json').version)")
PATCH_SCRIPT="$ROOT/scripts/patch-feed-manifest.mjs"
COPIED=0

# Suffix for this run's temporary files, so a concurrent or crashed run cannot
# collide with ours.
RUN_TAG="$(date +%s)-$RANDOM"
TAB="$(printf '\t')"

# Every file the staged manifests reference, and the size each one claims.
# Parallel arrays rather than packed strings: paths contain no reliable
# separator, and a wrong split here would silently skip a verification.
FEED_REFS=()
FEED_SIZES=()
# Manifests written but not yet live, and where each one belongs.
PENDING_TMP=()
PENDING_FINAL=()
# Basenames this run actually copied, to tell a fresh publish from a re-publish.
COPIED_NAMES=()

# A staged manifest must never outlive a failed run.
cleanup_staged() {
  local tmp
  for tmp in ${PENDING_TMP[@]+"${PENDING_TMP[@]}"}; do
    [ -f "$tmp" ] && rm -f "$tmp"
  done
  return 0
}
trap cleanup_staged EXIT

# ── Create version/platform subdirectories
WIN_DIR="$ONEDRIVE_DIR/$VERSION/win"
MAC_DIR="$ONEDRIVE_DIR/$VERSION/mac"
mkdir -p "$WIN_DIR" "$MAC_DIR"

# Read the `version:` field out of a channel manifest.
yml_version() {
  grep -m1 '^version:' "$1" 2>/dev/null \
    | sed -e 's/^version:[[:space:]]*//' -e "s/^['\"]//" -e "s/['\"]\$//" -e 's/[[:space:]]*$//'
}

# Copy an artifact into the feed atomically.
#
# `cp` writes ~180 MB in place at the final path, so for the whole duration of
# the copy both the sync client and any reader see a half-written file under its
# real name — indistinguishable from a complete one by an existence check. Copy
# to a temp sibling and rename instead: a rename within a directory is atomic, so
# the artifact is either absent or whole, never partial.
copy_artifact() {
  local src="$1" dest_dir="$2" dest_name="$3"
  local tmp="$dest_dir/.${dest_name}.partial.${RUN_TAG}"

  if ! cp -f "$src" "$tmp"; then
    rm -f "$tmp"
    echo "  ❌ Failed to copy ${dest_name} into the feed"
    exit 1
  fi
  mv -f "$tmp" "$dest_dir/$dest_name"

  COPIED_NAMES+=("$dest_name")
  echo "  ✓ ${dest_name} → $VERSION/$(basename "$dest_dir")/ ($(du -h "$src" | cut -f1 | xargs))"
  COPIED=$((COPIED + 1))
}

# Copy + patch one channel manifest, but ONLY when it describes this build.
#
# dist/ is not cleaned between platforms: after a Windows build, dist/latest.yml
# describes the Windows release and survives into the next Mac build. Copying it
# unconditionally (as this script used to) rewrote the *previous* version's
# manifest body into the *current* version's URL path, producing a feed entry
# that could never resolve. Leave the other platform's channel file alone.
#
# The patched manifest is staged next to its destination, never onto it — it only
# goes live once every file it references has been verified.
publish_manifest() {
  local channel="$1" platform="$2"
  local src="dist/${channel}"
  [ -f "$src" ] || return 0

  local found
  found="$(yml_version "$src")"
  if [ "$found" != "$VERSION" ]; then
    echo "  ⊘ ${channel} skipped — describes v${found:-unknown}, this build is v${VERSION}"
    return 0
  fi

  local staged="$ONEDRIVE_DIR/.${channel}.staged.${RUN_TAG}"
  local refs
  if ! refs="$(node "$PATCH_SCRIPT" "$src" "$staged" "$VERSION" "$platform")"; then
    rm -f "$staged"
    echo "  ❌ Failed to patch ${channel}"
    exit 1
  fi

  # Each line is "<relative-path><TAB><size>", size possibly empty.
  local line ref want
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    ref="${line%%"$TAB"*}"
    want="${line#*"$TAB"}"
    [ "$want" = "$ref" ] && want=""
    FEED_REFS+=("$ref")
    FEED_SIZES+=("$want")
  done <<< "$refs"

  PENDING_TMP+=("$staged")
  PENDING_FINAL+=("$ONEDRIVE_DIR/${channel}")
  echo "  ✓ ${channel} staged (urls → ${VERSION}/${platform}/)"
  COPIED=$((COPIED + 1))
}

# ── Windows artifacts
WIN_EXE="dist/code-atelier-${VERSION}-setup.exe"
if [ -f "$WIN_EXE" ]; then
  copy_artifact "$WIN_EXE" "$WIN_DIR" "$(basename "$WIN_EXE")"
fi
publish_manifest "latest.yml" "win"

# ── macOS artifacts
# electron-builder names the zip with spaces but writes the hyphenated "safe
# name" into latest-mac.yml. Publishing it verbatim made every Mac update 404 on
# download, so copy it under the name the manifest actually references.
MAC_ZIP=""
for candidate in dist/*"${VERSION}"*-mac.zip; do
  [ -f "$candidate" ] && MAC_ZIP="$candidate"
done
if [ -n "$MAC_ZIP" ]; then
  copy_artifact "$MAC_ZIP" "$MAC_DIR" "$(basename "$MAC_ZIP" | tr ' ' '-')"
fi
MAC_DMG="dist/code-atelier-${VERSION}.dmg"
if [ -f "$MAC_DMG" ]; then
  copy_artifact "$MAC_DMG" "$MAC_DIR" "$(basename "$MAC_DMG")"
fi
publish_manifest "latest-mac.yml" "mac"

# ── Verify every reference before any manifest goes live
# A manifest referencing a file that is not there is worse than a failed build
# step: the build looks green and every client 404s until someone notices.
#
# Existence is not enough. A partially transferred artifact sits at its final
# name with fewer bytes than the manifest promises, which passes `[ -f ]` and
# then fails the client's sha512 check after a multi-minute download. The
# manifest's own `size:` is the authority.
if [ "${#FEED_REFS[@]}" -gt 0 ]; then
  echo "  ▸ Verifying feed references..."
  MISSING=0
  i=0
  while [ "$i" -lt "${#FEED_REFS[@]}" ]; do
    ref="${FEED_REFS[$i]}"
    want="${FEED_SIZES[$i]}"
    target="$ONEDRIVE_DIR/$ref"
    i=$((i + 1))

    if [ ! -f "$target" ]; then
      echo "    ❌ missing: $ref"
      MISSING=$((MISSING + 1))
      continue
    fi

    if [ -n "$want" ]; then
      have="$(wc -c < "$target" | tr -d ' ')"
      if [ "$have" != "$want" ]; then
        echo "    ❌ incomplete: $ref ($have of $want bytes)"
        MISSING=$((MISSING + 1))
        continue
      fi
      echo "    ✓ $ref ($want bytes)"
    else
      echo "    ✓ $ref"
    fi

    # Legitimate on a re-publish, but it is also exactly what a dist/ missing
    # its installer looks like — so say which one this is.
    case " ${COPIED_NAMES[*]-} " in
      *" $(basename "$ref") "*) ;;
      *) echo "      ⓘ already in the feed — not copied by this run" ;;
    esac
  done

  if [ "$MISSING" -gt 0 ]; then
    echo "  ❌ Feed verification failed — $MISSING referenced file(s) missing or incomplete under $ONEDRIVE_DIR"
    echo "     Nothing was published: the feed still advertises the previous release."
    exit 1
  fi
fi

# ── Publish the manifests last
# Everything they point at has now been verified present and complete, so this
# rename is the moment the release becomes visible to clients. A rename within a
# directory is atomic — no client can observe a half-written manifest.
i=0
while [ "$i" -lt "${#PENDING_TMP[@]}" ]; do
  mv -f "${PENDING_TMP[$i]}" "${PENDING_FINAL[$i]}"
  echo "  ✓ $(basename "${PENDING_FINAL[$i]}") published"
  i=$((i + 1))
done

if [ $COPIED -eq 0 ]; then
  echo "  ⚠ No artifacts found in dist/ — nothing to publish"
else
  echo "  ✅ Published $COPIED artifact(s) to OneDrive (v${VERSION})"
  echo "  📁 $ONEDRIVE_DIR/$VERSION/{mac,win}/"
fi

# ── Report what each channel now advertises
# Each channel manifest is a single-version pointer, not a version history, and it
# only moves when that platform's artifacts are actually built. So a mac-only
# release leaves latest.yml describing the previous version, and Windows clients
# keep being offered that older build — indefinitely, and silently. The per-file
# "⊘ skipped" line above says so, but it scrolls past in the middle of a long
# build log, so restate the outcome as the last thing this script prints.
STALE_COUNT=0
STALE_HINTS=""

report_channel() {
  local channel="$1" platform="$2" build_cmd="$3"
  local live="$ONEDRIVE_DIR/${channel}"
  local found

  if [ ! -f "$live" ]; then
    echo "    ⚠ ${platform}: no ${channel} in the feed"
    STALE_COUNT=$((STALE_COUNT + 1))
    STALE_HINTS="${STALE_HINTS}    → ${platform} has no feed entry at all — run ${build_cmd}
"
    return 0
  fi

  found="$(yml_version "$live")"
  if [ "$found" = "$VERSION" ]; then
    echo "    ✓ ${platform}: v${found} (current)"
  else
    echo "    ⚠ ${platform}: v${found:-unknown} — stale, this build is v${VERSION}"
    STALE_COUNT=$((STALE_COUNT + 1))
    STALE_HINTS="${STALE_HINTS}    → ${platform} clients stay on v${found:-unknown} — run ${build_cmd}
"
  fi
}

echo ""
echo "  ▸ Feed channel status (what each platform will be offered)"
report_channel "latest-mac.yml" "macOS"   "npm run build:mac"
report_channel "latest.yml"     "Windows" "npm run build:win"

if [ "$STALE_COUNT" -gt 0 ]; then
  echo ""
  echo "  ⚠ Not every channel is on v${VERSION}."
  printf '%s' "$STALE_HINTS"
  echo "    Release both platforms in one command: npm run build:release"
fi

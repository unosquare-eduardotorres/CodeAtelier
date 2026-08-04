#!/bin/bash
# Usage: ./scripts/resize-avatar.sh <source.png> <dest-folder> <filename>
# Resizes a 1024px DALL-E avatar to 256x256 for the avatar system.
set -euo pipefail
SRC="$1"; DEST_DIR="$2"; FILENAME="$3"
mkdir -p "$DEST_DIR"
sips -z 256 256 "$SRC" --out "${DEST_DIR}/${FILENAME}" >/dev/null 2>&1
echo "✓ ${DEST_DIR}/${FILENAME} ($(du -h "${DEST_DIR}/${FILENAME}" | cut -f1))"

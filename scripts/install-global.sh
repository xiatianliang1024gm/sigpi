#!/usr/bin/env bash

# Build the current project, pack it into a tarball, and install that tarball
# into the pnpm global store so `sigpi` is available from any directory.
#
# Usage:
#   bash scripts/install-global.sh
#   bash scripts/install-global.sh --keep-tarball   # leave the .tgz in ./tmp
#
# After running, `sigpi` (the bin declared in package.json) is on your PATH
# via pnpm's global bin directory.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

KEEP_TARBALL=0
for arg in "$@"; do
  case "$arg" in
    --keep-tarball)
      KEEP_TARBALL=1
      ;;
    --help | -h)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "Unsupported argument: $arg" >&2
      exit 1
      ;;
  esac
done

# 1. Build fresh artifacts into dist/ (prepack would also build, but be explicit).
echo "==> Building project"
pnpm run build

# 2. Pack into a temp directory so we don't litter the repo root.
PACK_DIR="$(mktemp -d)"
trap '[[ "$KEEP_TARBALL" -eq 0 ]] && rm -rf "$PACK_DIR"' EXIT

echo "==> Packing tarball into $PACK_DIR"
pnpm pack --pack-destination "$PACK_DIR"

# 3. Locate the produced tarball.
TARBALL="$(find "$PACK_DIR" -maxdepth 1 -name '*.tgz' -print -quit)"
if [[ -z "$TARBALL" ]]; then
  echo "Failed to find packed tarball in $PACK_DIR" >&2
  exit 1
fi
echo "==> Packed: $TARBALL"

# 4. Install the tarball globally via pnpm.
echo "==> Installing globally with pnpm"
pnpm add -g "$TARBALL"

# 5. Report where the binary landed.
GLOBAL_BIN="$(pnpm bin -g)"
echo "==> Done. 'sigpi' is available from: $GLOBAL_BIN"
command -v sigpi >/dev/null 2>&1 && echo "==> Verified: $(command -v sigpi)" || \
  echo "==> Note: '$GLOBAL_BIN' may need to be on your PATH."

#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_JSON="$ROOT_DIR/package.json"
MANAGED_FILES=(package.json pnpm-lock.yaml)
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    *)
      echo "Unsupported argument: $arg" >&2
      exit 1
      ;;
  esac
done

CURRENT_VERSION="$(node --input-type=module --eval '
  import fs from "node:fs";

  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(pkg.version ?? ""));
' "$PACKAGE_JSON")"

NEXT_VERSION="$(node --input-type=module --eval '
  const version = process.argv[1];
  const match = /^(.*?)(\d{8})(\d{2})$/.exec(version);

  if (!match) {
    console.error(
      `Unsupported version format: ${version}. Expected <prefix>YYYYMMDDNN, for example 0.1.0-beta.2026052603.`,
    );
    process.exit(1);
  }

  const now = new Date();
  const today = [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const nextSequence = match[2] === today ? Number(match[3]) + 1 : 1;

  process.stdout.write(`${match[1]}${today}${String(nextSequence).padStart(2, "0")}`);
' "$CURRENT_VERSION")"

DIST_TAG="$(node --input-type=module --eval '
  const version = process.argv[1];
  const prereleaseMatch = /^[^-]+-([^.]+)\./.exec(version);
  process.stdout.write(prereleaseMatch?.[1] ?? "");
' "$NEXT_VERSION")"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "$NEXT_VERSION"
  exit 0
fi

DIRTY_FILES="$(git status --short --untracked-files=all -- "${MANAGED_FILES[@]}")"
if [[ -n "$DIRTY_FILES" ]]; then
  echo "Release-managed files must be clean before publishing:" >&2
  echo "$DIRTY_FILES" >&2
  exit 1
fi

BACKUP_FILE="$(mktemp)"
cp "$PACKAGE_JSON" "$BACKUP_FILE"

node --input-type=module --eval '
  import fs from "node:fs";

  const [packageJsonPath, version] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  pkg.version = version;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
' "$PACKAGE_JSON" "$NEXT_VERSION"

PUBLISH_ARGS=(publish --no-git-checks)
if [[ -n "$DIST_TAG" ]]; then
  PUBLISH_ARGS+=(--tag "$DIST_TAG")
fi

if ! pnpm "${PUBLISH_ARGS[@]}"; then
  cp "$BACKUP_FILE" "$PACKAGE_JSON"
  rm -f "$BACKUP_FILE"
  exit 1
fi

rm -f "$BACKUP_FILE"

git add package.json
if [[ -n "$(git status --short --untracked-files=all -- pnpm-lock.yaml)" ]]; then
  git add pnpm-lock.yaml
fi
git commit -m "chore: publish $NEXT_VERSION"

echo "Published $NEXT_VERSION"

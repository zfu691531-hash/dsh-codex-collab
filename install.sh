#!/bin/bash
set -euo pipefail

PROFILE_NAME="web"
DSH_BASE_URL="auto"
FORCE_SKILL=0
DRY_RUN=0

usage() {
  echo "Usage: ./install.sh [--profile NAME] [--dsh-base-url URL] [--force-skill] [--dry-run]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE_NAME="${2:?--profile requires a value}"
      shift 2
      ;;
    --dsh-base-url)
      DSH_BASE_URL="${2:?--dsh-base-url requires a value}"
      shift 2
      ;;
    --force-skill)
      FORCE_SKILL=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

resolve_executable() {
  local candidate
  for candidate in "$@"; do
    [[ -n "$candidate" ]] || continue
    if [[ "$candidate" == */* ]]; then
      [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
    elif command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_COMMAND="$(resolve_executable node /opt/homebrew/bin/node /usr/local/bin/node)" || {
  echo "NODE_NOT_FOUND: install Node.js or Homebrew Node" >&2
  exit 1
}
DSH_COMMAND="$(resolve_executable dsh /opt/homebrew/bin/dsh /usr/local/bin/dsh)" || {
  echo "DSH_NOT_FOUND: install DeepSeek Harness and its dsh CLI" >&2
  exit 1
}
CODEX_COMMAND="$(resolve_executable \
  codex \
  '/Applications/ChatGPT.app/Contents/Resources/codex' \
  '/Applications/Codex.app/Contents/Resources/codex' \
  "$HOME/.local/bin/codex" \
  /opt/homebrew/bin/codex \
  /usr/local/bin/codex)" || {
  echo "CODEX_NOT_FOUND: install ChatGPT/Codex or place codex on PATH" >&2
  exit 1
}

"$CODEX_COMMAND" --version >/dev/null 2>&1 || {
  echo "CODEX_NOT_EXECUTABLE: $CODEX_COMMAND" >&2
  exit 1
}

PACKAGE_FILES=("$SCRIPT_DIR"/dsh-codex-collab-*.tgz)
if [[ ${#PACKAGE_FILES[@]} -ne 1 || ! -f "${PACKAGE_FILES[0]}" ]]; then
  echo "Expected exactly one dsh-codex-collab TGZ beside install.sh" >&2
  exit 1
fi
PACKAGE_PATH="${PACKAGE_FILES[0]}"

CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
PROFILE_PATH="$DSH_ROOT/profiles/$PROFILE_NAME"
PATCH_PATH="$PROFILE_PATH/cordis.patch.yml"
STABLE_PACKAGE_DIR="$DSH_ROOT/packages/dsh-codex-collab"
STABLE_PACKAGE_PATH="$STABLE_PACKAGE_DIR/$(basename "$PACKAGE_PATH")"
STABLE_LAUNCHER_PATH="$STABLE_PACKAGE_DIR/launch-dsh-collab.mjs"
INSTALLED_ROOT="$PROFILE_PATH/node_modules/dsh-codex-collab"
SERVER_PATH="$INSTALLED_ROOT/dist/codex-mcp-server.js"
CONFIG_PATH="$CODEX_ROOT/config.toml"
SOURCE_SKILL="$SCRIPT_DIR/codex-skill/dsh-collab/SKILL.md"
TARGET_SKILL_DIR="$CODEX_ROOT/skills/dsh-collab"
TARGET_SKILL="$TARGET_SKILL_DIR/SKILL.md"

for required in "$SCRIPT_DIR/configure-codex.mjs" "$SCRIPT_DIR/configure-dsh.mjs" "$SCRIPT_DIR/launch-dsh-collab.mjs" "$SOURCE_SKILL"; do
  [[ -f "$required" ]] || { echo "Bundle file is missing: $required" >&2; exit 1; }
done

if [[ -f "$TARGET_SKILL" ]]; then
  SOURCE_HASH="$(shasum -a 256 "$SOURCE_SKILL" | awk '{print $1}')"
  TARGET_HASH="$(shasum -a 256 "$TARGET_SKILL" | awk '{print $1}')"
  if [[ "$SOURCE_HASH" != "$TARGET_HASH" && "$FORCE_SKILL" -ne 1 ]]; then
    echo "CODEX_SKILL_CONFLICT: $TARGET_SKILL differs; rerun with --force-skill to back it up" >&2
    exit 1
  fi
fi

"$NODE_COMMAND" "$SCRIPT_DIR/configure-codex.mjs" check-add "$CONFIG_PATH" "$NODE_COMMAND" "$SERVER_PATH" "$INSTALLED_ROOT" "$DSH_BASE_URL" "$STABLE_LAUNCHER_PATH"
"$NODE_COMMAND" "$SCRIPT_DIR/configure-dsh.mjs" check-add "$PATCH_PATH" "$CODEX_COMMAND"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY_RUN_OK"
  echo "Plugin package: $PACKAGE_PATH"
  echo "Stable package: $STABLE_PACKAGE_PATH"
  echo "DSH CLI: $DSH_COMMAND"
  echo "Codex CLI: $CODEX_COMMAND"
  echo "DSH Host URL: $DSH_BASE_URL"
  echo "DSH profile: $PROFILE_PATH"
  echo "Codex config: $CONFIG_PATH"
  echo "Codex skill: $TARGET_SKILL"
  exit 0
fi

mkdir -p "$STABLE_PACKAGE_DIR"
cp "$PACKAGE_PATH" "$STABLE_PACKAGE_PATH"
cp "$SCRIPT_DIR/launch-dsh-collab.mjs" "$STABLE_LAUNCHER_PATH"

DSH_ARGS=(plugin --profile "$PROFILE_NAME" add "$STABLE_PACKAGE_PATH")
MODULES_FILE="$PROFILE_PATH/node_modules/.modules.yaml"
MAX_LENGTH=""
if [[ -f "$MODULES_FILE" ]]; then
  MAX_LENGTH="$(sed -nE 's/^[[:space:]]*"?virtualStoreDirMaxLength"?[[:space:]]*:[[:space:]]*"?([0-9]+)"?.*/\1/p' "$MODULES_FILE" | head -n 1)"
fi
if [[ -n "$MAX_LENGTH" ]]; then
  PNPM_CONFIG_VIRTUAL_STORE_DIR_MAX_LENGTH="$MAX_LENGTH" "$DSH_COMMAND" "${DSH_ARGS[@]}"
else
  "$DSH_COMMAND" "${DSH_ARGS[@]}"
fi

[[ -f "$SERVER_PATH" ]] || {
  echo "DSH_PLUGIN_INCOMPLETE: companion server missing at $SERVER_PATH" >&2
  exit 1
}

if [[ -f "$TARGET_SKILL" ]]; then
  SOURCE_HASH="$(shasum -a 256 "$SOURCE_SKILL" | awk '{print $1}')"
  TARGET_HASH="$(shasum -a 256 "$TARGET_SKILL" | awk '{print $1}')"
  if [[ "$SOURCE_HASH" != "$TARGET_HASH" ]]; then
    SKILL_BACKUP="$TARGET_SKILL_DIR.backup-$(date +%Y%m%d-%H%M%S)"
    cp -R "$TARGET_SKILL_DIR" "$SKILL_BACKUP"
    echo "Existing Codex skill backed up to $SKILL_BACKUP"
  fi
fi
mkdir -p "$TARGET_SKILL_DIR"
cp "$SOURCE_SKILL" "$TARGET_SKILL"

"$NODE_COMMAND" "$SCRIPT_DIR/configure-codex.mjs" add "$CONFIG_PATH" "$NODE_COMMAND" "$SERVER_PATH" "$INSTALLED_ROOT" "$DSH_BASE_URL" "$STABLE_LAUNCHER_PATH"
"$NODE_COMMAND" "$SCRIPT_DIR/configure-dsh.mjs" add "$PATCH_PATH" "$CODEX_COMMAND"

echo
echo "INSTALL_OK"
echo "DSH profile: $PROFILE_NAME"
echo "Codex command: $CODEX_COMMAND"
echo "Codex config: $CONFIG_PATH"
echo "Codex skill: $TARGET_SKILL"
echo "Restart DeepSeek Harness and Codex, then run ./doctor.sh"

#!/bin/bash
set -euo pipefail

PROFILE_NAME="web"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE_NAME="${2:?--profile requires a value}"; shift 2 ;;
    -h|--help) echo "Usage: ./uninstall.sh [--profile NAME]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
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

NODE_COMMAND="$(resolve_executable node /opt/homebrew/bin/node /usr/local/bin/node)" || { echo "NODE_NOT_FOUND" >&2; exit 1; }
DSH_COMMAND="$(resolve_executable dsh /opt/homebrew/bin/dsh /usr/local/bin/dsh || true)"
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
CONFIG_PATH="$CODEX_ROOT/config.toml"
TARGET_SKILL_DIR="$CODEX_ROOT/skills/dsh-collab"
TARGET_SKILL="$TARGET_SKILL_DIR/SKILL.md"
SOURCE_SKILL="$SCRIPT_DIR/codex-skill/dsh-collab/SKILL.md"
PROFILE_PATH="$DSH_ROOT/profiles/$PROFILE_NAME"
PATCH_PATH="$PROFILE_PATH/cordis.patch.yml"
STABLE_PACKAGE_DIR="$DSH_ROOT/packages/dsh-codex-collab"

PLUGIN_LIST=""
if [[ -n "$DSH_COMMAND" ]]; then
  if PLUGIN_LIST="$("$DSH_COMMAND" plugin --profile "$PROFILE_NAME" list --depth 0 2>&1)"; then
    :
  else
    LIST_EXIT=$?
    echo "DSH_PLUGIN_LIST_FAILED: $PLUGIN_LIST" >&2
    exit "$LIST_EXIT"
  fi
fi

"$NODE_COMMAND" "$SCRIPT_DIR/configure-codex.mjs" remove "$CONFIG_PATH"
"$NODE_COMMAND" "$SCRIPT_DIR/configure-dsh.mjs" remove "$PATCH_PATH"

if [[ -f "$SOURCE_SKILL" && -f "$TARGET_SKILL" ]]; then
  SOURCE_HASH="$(shasum -a 256 "$SOURCE_SKILL" | awk '{print $1}')"
  TARGET_HASH="$(shasum -a 256 "$TARGET_SKILL" | awk '{print $1}')"
  if [[ "$SOURCE_HASH" == "$TARGET_HASH" ]]; then
    case "$TARGET_SKILL_DIR" in
      "$CODEX_ROOT"/skills/*) rm -rf "$TARGET_SKILL_DIR" ;;
      *) echo "Refusing to remove skill outside $CODEX_ROOT/skills" >&2; exit 1 ;;
    esac
    echo "CODEX_SKILL_REMOVED"
  else
    echo "Codex skill was modified and was preserved at $TARGET_SKILL_DIR" >&2
  fi
fi

if [[ -n "$DSH_COMMAND" ]]; then
  if echo "$PLUGIN_LIST" | grep -q 'dsh-codex-collab@'; then
    DSH_ARGS=(plugin --profile "$PROFILE_NAME" remove dsh-codex-collab)
    MODULES_FILE="$PROFILE_PATH/node_modules/.modules.yaml"
    if [[ -f "$MODULES_FILE" ]]; then
      MAX_LENGTH="$(sed -nE 's/^[[:space:]]*"?virtualStoreDirMaxLength"?[[:space:]]*:[[:space:]]*"?([0-9]+)"?.*/\1/p' "$MODULES_FILE" | head -n 1)"
    fi
    if [[ -n "${MAX_LENGTH:-}" ]]; then
      PNPM_CONFIG_VIRTUAL_STORE_DIR_MAX_LENGTH="$MAX_LENGTH" "$DSH_COMMAND" "${DSH_ARGS[@]}"
    else
      "$DSH_COMMAND" "${DSH_ARGS[@]}"
    fi
  fi
else
  echo "dsh was not found; the DSH plugin was not removed" >&2
fi

if [[ -d "$STABLE_PACKAGE_DIR" ]]; then
  case "$STABLE_PACKAGE_DIR" in
    "$DSH_ROOT"/packages/*) rm -rf "$STABLE_PACKAGE_DIR" ;;
    *) echo "Refusing to remove package outside $DSH_ROOT/packages" >&2; exit 1 ;;
  esac
  echo "STABLE_PLUGIN_PACKAGE_REMOVED"
fi

echo "UNINSTALL_OK"
echo "Restart DeepSeek Harness and Codex."

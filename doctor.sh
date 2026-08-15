#!/bin/bash
set -euo pipefail

PROFILE_NAME="web"
DSH_BASE_URL="auto"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE_NAME="${2:?--profile requires a value}"; shift 2 ;;
    --dsh-base-url) DSH_BASE_URL="${2:?--dsh-base-url requires a value}"; shift 2 ;;
    -h|--help) echo "Usage: ./doctor.sh [--profile NAME] [--dsh-base-url URL]"; exit 0 ;;
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
DSH_COMMAND="$(resolve_executable dsh /opt/homebrew/bin/dsh /usr/local/bin/dsh)" || { echo "DSH_NOT_FOUND" >&2; exit 1; }
CODEX_COMMAND="$(resolve_executable codex '/Applications/ChatGPT.app/Contents/Resources/codex' '/Applications/Codex.app/Contents/Resources/codex' "$HOME/.local/bin/codex" /opt/homebrew/bin/codex /usr/local/bin/codex)" || { echo "CODEX_NOT_FOUND" >&2; exit 1; }

CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
PROFILE_PATH="$DSH_ROOT/profiles/$PROFILE_NAME"
INSTALLED_ROOT="$PROFILE_PATH/node_modules/dsh-codex-collab"
SERVER_PATH="$INSTALLED_ROOT/dist/codex-mcp-server.js"
CONFIG_PATH="$CODEX_ROOT/config.toml"
SKILL_PATH="$CODEX_ROOT/skills/dsh-collab/SKILL.md"
PATCH_PATH="$PROFILE_PATH/cordis.patch.yml"
LAUNCHER_PATH="$DSH_ROOT/packages/dsh-codex-collab/launch-dsh-collab.mjs"

PLUGIN_LIST="$("$DSH_COMMAND" plugin --profile "$PROFILE_NAME" list --depth 0)"
echo "$PLUGIN_LIST" | grep -q 'dsh-codex-collab@' || { echo "DSH_PLUGIN_NOT_INSTALLED" >&2; exit 1; }
echo "$PLUGIN_LIST" | grep 'dsh-codex-collab@'

[[ -f "$CONFIG_PATH" ]] || { echo "CODEX_CONFIG_NOT_FOUND" >&2; exit 1; }
grep -q '^# >>> dsh-codex-collab managed MCP >>>$' "$CONFIG_PATH" || { echo "CODEX_MCP_NOT_CONFIGURED" >&2; exit 1; }
[[ -f "$PATCH_PATH" ]] && grep -q '^# >>> dsh-codex-collab managed config >>>$' "$PATCH_PATH" || { echo "DSH_PLUGIN_CONFIG_NOT_CONFIGURED" >&2; exit 1; }
[[ -f "$SKILL_PATH" ]] || { echo "CODEX_SKILL_NOT_INSTALLED" >&2; exit 1; }
[[ -f "$SERVER_PATH" ]] || { echo "MCP_SERVER_NOT_INSTALLED" >&2; exit 1; }
[[ -f "$LAUNCHER_PATH" ]] || { echo "MCP_LAUNCHER_NOT_INSTALLED" >&2; exit 1; }
"$CODEX_COMMAND" --version
"$CODEX_COMMAND" app-server --help >/dev/null
echo "CODEX_APP_SERVER_OK"

RESOLVED_BASE_URL="$(DSH_BASE_URL="$DSH_BASE_URL" "$NODE_COMMAND" "$LAUNCHER_PATH" --print-base)"
HTTP_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 5 "$RESOLVED_BASE_URL/")" || {
  echo "DSH_UNAVAILABLE: restart DeepSeek Harness and retry" >&2
  exit 1
}
[[ "$HTTP_STATUS" == "200" ]] || { echo "DSH_HTTP_ERROR: $HTTP_STATUS" >&2; exit 1; }
echo "DSH_HTTP_OK $HTTP_STATUS"
echo "DSH_BASE_URL $RESOLVED_BASE_URL"

"$NODE_COMMAND" "$SCRIPT_DIR/mcp-smoke.mjs" "$NODE_COMMAND" "$SERVER_PATH" "$INSTALLED_ROOT" "$DSH_BASE_URL" "$LAUNCHER_PATH"
echo "DOCTOR_OK"
echo "Open a new Codex task and say: Collaborate with DSH on this task."

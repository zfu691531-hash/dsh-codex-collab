#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/doctor.sh" "$@"
STATUS=$?
echo
read -r -p "Press Enter to close..."
exit "$STATUS"

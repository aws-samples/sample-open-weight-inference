#!/usr/bin/env bash
# Operator/bootstrap entry point. Requires SPEECH_MODEL_ARCHIVE and SPEECH_MODEL_SHA256.
set -Eeuo pipefail
EDDIE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec "$EDDIE_REPO_ROOT/.venv/bin/python" \
  "$EDDIE_REPO_ROOT/scripts/workshop/bootstrap.py" speech-model "$@"

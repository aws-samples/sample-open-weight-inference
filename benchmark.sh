#!/usr/bin/env bash
# Companion runner for existing endpoints. Validation is the default.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$ROOT/.venv/bin/python" ]]; then
  BENCHMARK_PYTHON="$ROOT/.venv/bin/python"
else
  BENCHMARK_PYTHON="${EDDIE_PYTHON:-python3}"
fi
export PYTHONPATH="$ROOT/backend${PYTHONPATH:+:$PYTHONPATH}"
exec "$BENCHMARK_PYTHON" -m evaluation.runner "$@"

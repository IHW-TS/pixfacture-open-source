#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VENV_BIN="$ROOT/.venv/bin"
if [ -d "$VENV_BIN" ]; then
  PATH="$VENV_BIN:$PATH"
fi
export PYTHONPATH="$ROOT"

ruff check --config pyproject.toml app tests
mypy --config-file pyproject.toml app/compliance app/services/cii.py
pytest

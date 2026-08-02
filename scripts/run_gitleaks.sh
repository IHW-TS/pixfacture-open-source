#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${GITLEAKS_DOCKER_IMAGE:-zricethezav/gitleaks:latest}"
LOCAL_GITLEAKS="${ROOT_DIR}/.tools/bin/gitleaks"

# The global allowlist excludes only generated caches. Refuse the scan if one
# of those paths ever enters the Git index, otherwise a forced add could hide a
# real secret behind an artifact exception.
tracked_generated="$({
  git -C "$ROOT_DIR" ls-files 2>/dev/null \
    | grep -E '(^|/)(\.next|__pycache__)(/|$)|\.py[co]$' || true
})"
if [[ -n "$tracked_generated" ]]; then
  echo "Fichiers générés interdits dans l'index Git:" >&2
  printf '%s\n' "$tracked_generated" >&2
  exit 1
fi

if [[ -x "${LOCAL_GITLEAKS}" ]]; then
  exec "${LOCAL_GITLEAKS}" "$@"
fi

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "gitleaks introuvable et Docker indisponible." >&2
  echo "Installez gitleaks localement, ou deposez un binaire dans ${LOCAL_GITLEAKS}." >&2
  exit 127
fi

if ! docker info >/dev/null 2>&1; then
  echo "gitleaks introuvable et Docker n'est pas accessible pour l'utilisateur courant." >&2
  echo "Installez gitleaks localement, deposez un binaire dans ${LOCAL_GITLEAKS}, ou activez l'acces Docker." >&2
  exit 126
fi

workdir="/workspace"
if [[ "${PWD}" == "${ROOT_DIR}" ]]; then
  workdir="/workspace"
elif [[ "${PWD}" == "${ROOT_DIR}/"* ]]; then
  rel_path="${PWD#${ROOT_DIR}/}"
  workdir="/workspace/${rel_path}"
fi

exec docker run --rm \
  -v "${ROOT_DIR}:/workspace" \
  -w "${workdir}" \
  "${IMAGE}" \
  "$@"

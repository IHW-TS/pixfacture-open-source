#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
target="${1:-}"
archive=""
acme_path="${ROOT_DIR}/traefik/acme.json"
max_bytes=$((50 * 1024 * 1024))
STRICT_LOCAL_VENV="${CHECK_LOCAL_VENV_STRICT:-false}"
SOURCE_ONLY="${CHECK_REPO_HYGIENE_SOURCE_ONLY:-false}"

list_archive_entries() {
  local archive_path="$1"
  if command -v unzip >/dev/null 2>&1; then
    unzip -Z1 "${archive_path}"
    return
  fi
  python3 - "${archive_path}" <<'PY'
import sys
import zipfile

archive = sys.argv[1]
with zipfile.ZipFile(archive) as zf:
    for name in zf.namelist():
        print(name)
PY
}

scan_release_hygiene() {
  local scan_root="${1:-${ROOT_DIR}}"
  local archive_path="${2:-}"
  python3 - "${scan_root}" "${archive_path}" <<'PY'
import re
import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1]).resolve()
archive_arg = sys.argv[2]
archive = Path(archive_arg).resolve() if archive_arg else None

skip_dirs = {
    ".git",
    ".mypy_cache",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "logs",
    "node_modules",
    "postgres_data",
    "reports",
    "secrets",
    "venv",
}
source_forbidden_dirs = {
    ".tools",
    "storage",
    "test-results",
    "test-storage",
}
source_forbidden_files = {".last-run.json", "cookies.txt", "mkdir", "mkdir.save"}
archive_forbidden_dirs = skip_dirs | source_forbidden_dirs | {
    ".backups",
    "backups",
    "coverage",
    "playwright-report",
    "reports",
}
tmp_file_re = re.compile(r"(^|/)tmp_[^/]*\.(?:js|jsx|ts|tsx|mjs|cjs)$")
compiled_python_re = re.compile(r"(^|/).*\.py[co]$")
public_token_re = re.compile(r"(?:https?://[^\s'\"<>]+)?/(?:i|q|c)/[A-Za-z0-9_-]{20,}")
text_suffixes = {
    ".css",
    ".csv",
    ".env",
    ".example",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".py",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
max_scan_bytes = 2 * 1024 * 1024
failures: list[tuple[str, str]] = []


def rel(path: Path) -> str:
    return path.relative_to(root).as_posix()


def should_skip(path: Path) -> bool:
    return any(part in skip_dirs for part in path.relative_to(root).parts[:-1])


def is_text_candidate(path: Path) -> bool:
    return path.suffix.lower() in text_suffixes or ".env" in path.name


if not root.exists():
    print(f"Chemin source introuvable: {root}", file=sys.stderr)
    sys.exit(1)

for path in root.rglob("*"):
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        continue
    if path.is_dir():
        if path.name in source_forbidden_dirs:
            failures.append(("dossier artefact interdit", rel(path)))
        continue
    if not path.is_file() or should_skip(path):
        continue
    if any(part in source_forbidden_dirs for part in parts[:-1]):
        continue
    name = rel(path)
    if path.name in source_forbidden_files:
        failures.append(("fichier artefact interdit", name))
    if tmp_file_re.search(name):
        failures.append(("fichier temporaire interdit", name))
    if compiled_python_re.search(name):
        failures.append(("fichier Python compile interdit", name))
    if not is_text_candidate(path):
        continue
    try:
        if path.stat().st_size > max_scan_bytes:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        continue
    if public_token_re.search(text):
        failures.append(("lien public tokenise interdit", name))

if archive and archive.exists():
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            name = info.filename
            path_name = Path(name)
            parts = path_name.parts
            if any(part in archive_forbidden_dirs for part in parts[:-1]):
                failures.append(("archive: dossier artefact interdit", name))
            if path_name.name in source_forbidden_files:
                failures.append(("archive: fichier artefact interdit", name))
            if path_name.name.endswith(".tsbuildinfo") or tmp_file_re.search(name):
                failures.append(("archive: fichier temporaire interdit", name))
            if compiled_python_re.search(name):
                failures.append(("archive: fichier Python compile interdit", name))
            suffix = path_name.suffix.lower()
            if suffix not in text_suffixes and ".env" not in Path(name).name:
                continue
            if info.file_size > max_scan_bytes:
                continue
            try:
                text = zf.read(info).decode("utf-8", errors="ignore")
            except Exception:
                continue
            if public_token_re.search(text):
                failures.append(("archive: lien public tokenise interdit", name))

if failures:
    print("Hygiene release echouee:", file=sys.stderr)
    for label, name in failures:
        print(f"- {label}: {name}", file=sys.stderr)
    sys.exit(1)
PY
}

bad_venv="$(find "${ROOT_DIR}" \
  -type d \( -name .git -o -name node_modules -o -name dist -o -name build \) -prune -o \
  -type d \( -name .venv -o -name venv \) -print 2>/dev/null || true)"
if [[ -n "${bad_venv}" ]]; then
  if [[ "${STRICT_LOCAL_VENV,,}" == "true" || "${STRICT_LOCAL_VENV}" == "1" ]]; then
    echo "Dossiers de virtualenv interdits detectes:" >&2
    printf '%s\n' "${bad_venv}" >&2
    exit 1
  fi
  echo "Info: virtualenv local detecte, ignore pour l'hygiene workspace; l'archive restera verifiee strictement." >&2
fi

bad_env="$(find "${ROOT_DIR}" \
  -type d \( -name .git -o -name node_modules -o -name dist -o -name build -o -name .venv -o -name venv \) -prune -o \
  -type f -name ".env*" ! -name "*.example" -print 2>/dev/null || true)"
if [[ -n "${bad_env}" ]]; then
  echo "Fichiers .env non example detectes:" >&2
  printf '%s\n' "${bad_env}" >&2
  exit 1
fi

bad_acme="$(find "${ROOT_DIR}" \
  -type d \( -name .git -o -name node_modules -o -name dist -o -name build \) -prune -o \
  -type f -name "acme.json" -print 2>/dev/null || true)"
if [[ -n "${bad_acme}" || -f "${acme_path}" ]]; then
  echo "Le fichier acme.json est interdit dans le repo et dans les archives." >&2
  printf '%s\n' "${bad_acme}" >&2
  exit 1
fi

scan_release_hygiene "${ROOT_DIR}" ""

if [[ -n "${target}" && -d "${target}" ]]; then
  scan_root="$(cd "${target}" && pwd)"
  scan_release_hygiene "${scan_root}" ""
  echo "OK: hygiene source verifiee."
  exit 0
fi

if [[ "${SOURCE_ONLY,,}" == "true" || "${SOURCE_ONLY}" == "1" ]]; then
  echo "OK: hygiene source verifiee."
  exit 0
fi

if [[ -n "${target}" ]]; then
  archive="${target}"
else
  archive="$(ls -t "${ROOT_DIR}"/dist/*.zip 2>/dev/null | head -1 || true)"
fi

if [[ -z "${archive}" || ! -f "${archive}" ]]; then
  echo "Archive introuvable. Fournissez un chemin ou creez dist/*.zip." >&2
  exit 1
fi

scan_release_hygiene "${ROOT_DIR}" "${archive}"

archive_size="$(stat -c %s "${archive}")"
if [[ "${archive_size}" -gt "${max_bytes}" ]]; then
  size_human="$(du -h "${archive}" | cut -f1)"
  echo "Archive trop lourde (${size_human}) : limite 50MB depassee." >&2
  exit 1
fi

files="$(list_archive_entries "${archive}")"

env_entries="$(printf '%s\n' "${files}" | grep -E '(^|/)\.env' || true)"
bad_env_entries="$(printf '%s\n' "${env_entries}" | grep -Ev '\.example$' || true)"
if [[ -n "${bad_env_entries}" ]]; then
  echo "Archive contient des .env non example:" >&2
  printf '%s\n' "${bad_env_entries}" >&2
  exit 1
fi

banned_patterns=(
  '(^|/)\.backups(/|$)'
  '(^|/)backups(/|$)'
  '(^|/)\.tools(/|$)'
  '(^|/)\.git(/|$)'
  '(^|/)\.mypy_cache(/|$)'
  '(^|/)\.ruff_cache(/|$)'
  '(^|/)node_modules(/|$)'
  '(^|/)\.next(/|$)'
  '(^|/)__pycache__(/|$)'
  '(^|/)\.pytest_cache(/|$)'
  '(^|/)\.venv(/|$)'
  '(^|/)venv(/|$)'
  '(^|/)dist(/|$)'
  '(^|/)build(/|$)'
  '(^|/)postgres_data(/|$)'
  '(^|/)secrets(/|$)'
  '(^|/)logs(/|$)'
  '(^|/)reports(/|$)'
  '(^|/)storage(/|$)'
  '(^|/)test-results(/|$)'
  '(^|/)test-storage(/|$)'
  '(^|/)\.last-run\.json$'
  '(^|/)traefik/acme\.json$'
  '(^|/)cookies\.txt$'
  '(^|/)mkdir(\.save)?$'
  '(^|/)tmp_[^/]*\.(js|jsx|ts|tsx|mjs|cjs)$'
  '(^|/).*\.py[co]$'
  '\.db$'
  '\.db-journal$'
  '\.db-wal$'
  '\.db-shm$'
  '\.sqlite-journal$'
  '\.sqlite3-journal$'
  '\.log$'
  '\.tsbuildinfo$'
)

for pattern in "${banned_patterns[@]}"; do
  matches="$(printf '%s\n' "${files}" | grep -E "${pattern}" || true)"
  if [[ -n "${matches}" ]]; then
    echo "Archive contient un chemin interdit (pattern: ${pattern})." >&2
    printf '%s\n' "${matches}" >&2
    exit 1
  fi
done

echo "OK: aucune trace d'artefacts dans ${archive}."

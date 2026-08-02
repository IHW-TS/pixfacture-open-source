#!/usr/bin/env bash
set -euo pipefail

is_truthy() {
  case "${1:-}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

pick_python_bin() {
  if command -v python >/dev/null 2>&1; then
    printf '%s\n' "python"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    printf '%s\n' "python3"
    return 0
  fi
  return 1
}

app_env_raw="${APP_ENV:-}"
app_env="$(printf '%s' "$app_env_raw" | tr '[:upper:]' '[:lower:]')"
if [[ "$app_env" == "prod" || "$app_env" == "production" || "$app_env" == "staging" ]]; then
  if [[ "${1:-}" == "uvicorn" ]]; then
    if is_truthy "${RUN_PROD_DOCTOR_ON_STARTUP:-true}"; then
      prod_doctor_path="${PROD_DOCTOR_PATH:-/opt/ops/prod_doctor.py}"
      prod_doctor_python="${PROD_DOCTOR_PYTHON:-$(pick_python_bin || true)}"
      if [[ ! -f "$prod_doctor_path" || ! -r "$prod_doctor_path" ]]; then
        echo "prod_doctor.py introuvable ou illisible ($prod_doctor_path)." >&2
        exit 1
      fi
      if [[ -z "${prod_doctor_python}" ]]; then
        echo "Impossible d'executer prod_doctor.py: ni python ni python3 n'est disponible." >&2
        exit 1
      fi
      echo "Running prod doctor ($prod_doctor_path)"
      "${prod_doctor_python}" "$prod_doctor_path"
    else
      echo "RUN_PROD_DOCTOR_ON_STARTUP=false interdit en prod/staging." >&2
      exit 1
    fi
  fi
fi

if [ "${RUN_MIGRATIONS_ON_STARTUP:-false}" = "true" ]; then
  echo "Running migrations (RUN_MIGRATIONS_ON_STARTUP=true)"
  alembic -c /app/alembic.ini upgrade head
else
  echo "Skipping migrations (RUN_MIGRATIONS_ON_STARTUP=${RUN_MIGRATIONS_ON_STARTUP:-false})"
fi

exec "$@"

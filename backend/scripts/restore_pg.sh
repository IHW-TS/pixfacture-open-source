#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage:
  restore_pg.sh <backup_path_or_s3_uri>
  restore_pg.sh smoke <backup_path_or_s3_uri>

Env:
  DATABASE_URL            Target database URL for standard restore.
  STAGING_DATABASE_URL    Target database URL for smoke restore (alias: SMOKE_DATABASE_URL).
  CONFIRM_RESTORE=YES     Required to proceed for standard restore.
  CONFIRM_SMOKE_RESTORE=YES  Required to proceed for smoke restore.
  S3_ENDPOINT_URL         Optional S3 endpoint URL.
  VERIFY_TABLE            Table name to verify after restore (default: tenants).
EOF
}

if [ $# -lt 1 ]; then
  usage
  exit 1
fi

MODE="standard"
SOURCE="$1"
if [ "$1" = "smoke" ]; then
  MODE="smoke"
  if [ $# -lt 2 ]; then
    usage
    exit 1
  fi
  SOURCE="$2"
fi

if [ "$MODE" = "smoke" ]; then
  if [ "${CONFIRM_SMOKE_RESTORE:-}" != "YES" ]; then
    echo "Set CONFIRM_SMOKE_RESTORE=YES to proceed."; exit 1
  fi
  DB_URL="${SMOKE_DATABASE_URL:-${STAGING_DATABASE_URL:-}}"
  if [ -z "$DB_URL" ]; then
    echo "SMOKE_DATABASE_URL or STAGING_DATABASE_URL is required for smoke restore."; exit 1
  fi
else
  if [ "${CONFIRM_RESTORE:-}" != "YES" ]; then
    echo "Set CONFIRM_RESTORE=YES to proceed."; exit 1
  fi
  DB_URL="${DATABASE_URL:-}"
  if [ -z "$DB_URL" ]; then
    echo "DATABASE_URL is required for restore."; exit 1
  fi
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1"; exit 1; }
}

require_cmd psql
require_cmd gzip

TMP_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

SRC_PATH="$SOURCE"
if [[ "$SOURCE" == s3://* ]]; then
  require_cmd aws
  S3_ENDPOINT_URL=${S3_ENDPOINT_URL:-}
  AWS_ARGS=()
  if [ -n "$S3_ENDPOINT_URL" ]; then
    AWS_ARGS+=("--endpoint-url" "$S3_ENDPOINT_URL")
  fi
  aws s3 cp "$SOURCE" "$TMP_DIR/" "${AWS_ARGS[@]}"
  SRC_PATH="$TMP_DIR/$(basename "$SOURCE")"
fi

if [ ! -f "$SRC_PATH" ]; then
  echo "Backup file not found: $SRC_PATH"; exit 1
fi

DECRYPTED="$TMP_DIR/backup.sql.gz"
if [[ "$SRC_PATH" == *.age ]]; then
  require_cmd age
  age -d -o "$DECRYPTED" "$SRC_PATH"
elif [[ "$SRC_PATH" == *.gpg ]]; then
  require_cmd gpg
  gpg --batch --yes --decrypt --output "$DECRYPTED" "$SRC_PATH"
else
  echo "Unsupported backup format (expected .age or .gpg)."; exit 1
fi

gzip -t "$DECRYPTED"

psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction < <(gzip -dc "$DECRYPTED")

VERIFY_TABLE=${VERIFY_TABLE:-tenants}
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) FROM ${VERIFY_TABLE};" >/dev/null

echo "Restore completed and verified (table: $VERIFY_TABLE)."

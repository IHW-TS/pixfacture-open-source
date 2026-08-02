#!/usr/bin/env bash
set -euo pipefail
umask 077

BACKUP_DIR=${BACKUP_DIR:-/var/backups/sass}
BACKUP_PREFIX=${BACKUP_PREFIX:-pg}
S3_BUCKET=${S3_BUCKET:-}
S3_PREFIX=${S3_PREFIX:-postgres}
S3_ENDPOINT_URL=${S3_ENDPOINT_URL:-}
S3_STORAGE_CLASS=${S3_STORAGE_CLASS:-}
BACKUP_LOCAL_RETENTION_DAYS=${BACKUP_LOCAL_RETENTION_DAYS:-}

AGE_RECIPIENTS=${AGE_RECIPIENTS:-}
AGE_RECIPIENTS_FILE=${AGE_RECIPIENTS_FILE:-}
GPG_RECIPIENT=${GPG_RECIPIENT:-}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1"; exit 1; }
}

require_cmd pg_dump
require_cmd gzip
require_cmd aws

if [ -z "$S3_BUCKET" ]; then
  echo "S3_BUCKET is required."; exit 1
fi

ENC_MODE=""
if [ -n "$AGE_RECIPIENTS" ] || [ -n "$AGE_RECIPIENTS_FILE" ]; then
  require_cmd age
  ENC_MODE="age"
elif [ -n "$GPG_RECIPIENT" ]; then
  require_cmd gpg
  ENC_MODE="gpg"
else
  echo "Set AGE_RECIPIENTS/AGE_RECIPIENTS_FILE or GPG_RECIPIENT for encryption."; exit 1
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP_NAME="${BACKUP_PREFIX}_${STAMP}.sql.gz"
TMP_DIR=$(mktemp -d)
DUMP_PATH="$TMP_DIR/$DUMP_NAME"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"

PG_DSN=${DATABASE_URL:-}
if [ -z "$PG_DSN" ]; then
  : "${PGHOST:?PGHOST is required when DATABASE_URL is not set}"
  : "${PGUSER:?PGUSER is required when DATABASE_URL is not set}"
  : "${PGDATABASE:?PGDATABASE is required when DATABASE_URL is not set}"
  PGPORT=${PGPORT:-5432}
  PG_DSN="postgresql://${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
fi

pg_dump "$PG_DSN" --no-owner --no-privileges --format=plain | gzip -c > "$DUMP_PATH"

ENC_PATH=""
if [ "$ENC_MODE" = "age" ]; then
  ENC_PATH="$BACKUP_DIR/${DUMP_NAME}.age"
  if [ -n "$AGE_RECIPIENTS_FILE" ]; then
    age -R "$AGE_RECIPIENTS_FILE" -o "$ENC_PATH" "$DUMP_PATH"
  else
    IFS=',' read -r -a recips <<< "$AGE_RECIPIENTS"
    AGE_ARGS=()
    for r in "${recips[@]}"; do
      r_trim=$(echo "$r" | xargs)
      if [ -n "$r_trim" ]; then
        AGE_ARGS+=("-r" "$r_trim")
      fi
    done
    age "${AGE_ARGS[@]}" -o "$ENC_PATH" "$DUMP_PATH"
  fi
else
  ENC_PATH="$BACKUP_DIR/${DUMP_NAME}.gpg"
  gpg --batch --yes --encrypt --recipient "$GPG_RECIPIENT" --output "$ENC_PATH" "$DUMP_PATH"
fi

CHECKSUM=$(sha256sum "$ENC_PATH" | awk '{print $1}')

S3_KEY="${S3_PREFIX%/}/$(basename "$ENC_PATH")"
S3_URI="s3://${S3_BUCKET}/${S3_KEY}"
AWS_ARGS=()
if [ -n "$S3_ENDPOINT_URL" ]; then
  AWS_ARGS+=("--endpoint-url" "$S3_ENDPOINT_URL")
fi
if [ -n "$S3_STORAGE_CLASS" ]; then
  AWS_ARGS+=("--storage-class" "$S3_STORAGE_CLASS")
fi

aws s3 cp "$ENC_PATH" "$S3_URI" "${AWS_ARGS[@]}"

echo "Backup uploaded: $S3_URI"
echo "SHA256: $CHECKSUM"

if [ -n "$BACKUP_LOCAL_RETENTION_DAYS" ]; then
  find "$BACKUP_DIR" -type f -name "${BACKUP_PREFIX}_*.sql.gz.*" -mtime "+$BACKUP_LOCAL_RETENTION_DAYS" -print -delete
fi

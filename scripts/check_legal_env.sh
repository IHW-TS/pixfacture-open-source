#!/usr/bin/env bash
set -euo pipefail

app_env="${APP_ENV:-}"
app_env="$(printf '%s' "$app_env" | tr '[:upper:]' '[:lower:]' | xargs)"

if [[ "$app_env" != "prod" && "$app_env" != "production" && "$app_env" != "staging" ]]; then
  exit 0
fi

PLACEHOLDER_TOKENS=(
  "change_me"
  "your_"
  "todo"
  "tbd"
  "example.com"
  "metre_ton"
  "mettre_ton"
  "ton_"
  "ta_"
  "a_remplir"
)

is_missing() {
  local value="$1"
  value="$(printf '%s' "$value" | xargs)"
  if [[ -z "$value" ]]; then
    return 0
  fi
  if [[ "$value" == *"<<"* || "$value" == *">>"* ]]; then
    return 0
  fi
  local lower="${value,,}"
  local token
  for token in "${PLACEHOLDER_TOKENS[@]}"; do
    if [[ "$lower" == *"$token"* ]]; then
      return 0
    fi
  done
  return 1
}

missing_entries=()

check_group() {
  local label="$1"
  shift
  local keys=("$@")
  local key
  for key in "${keys[@]}"; do
    if ! is_missing "${!key-}"; then
      return 0
    fi
  done
  local joined
  joined="$(IFS=' | '; printf '%s' "${keys[*]}")"
  missing_entries+=("${label}: ${joined}")
}

check_group "company name" "NEXT_PUBLIC_LEGAL_COMPANY_NAME"
check_group "company capital" "NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL" "NEXT_PUBLIC_LEGAL_COMPANY_SHARE_CAPITAL"
check_group "company address" "NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS" "NEXT_PUBLIC_LEGAL_ADDRESS"
check_group "company email" "NEXT_PUBLIC_LEGAL_COMPANY_EMAIL" "NEXT_PUBLIC_LEGAL_EMAIL"
check_group "company phone" "NEXT_PUBLIC_LEGAL_COMPANY_PHONE" "NEXT_PUBLIC_CONTACT_PHONE"
check_group "publisher director" "NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR" "NEXT_PUBLIC_LEGAL_DIRECTOR_PUBLICATION"
check_group "hosting provider name" "NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_NAME" "NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER"
check_group "hosting provider address" "NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_ADDRESS" "NEXT_PUBLIC_LEGAL_HOSTING_LOCATION"
check_group "hosting provider phone" "NEXT_PUBLIC_LEGAL_HOSTING_PHONE"
check_group "privacy contact email" \
  "NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT_EMAIL" \
  "NEXT_PUBLIC_LEGAL_DPO_EMAIL" \
  "NEXT_PUBLIC_DPO_EMAIL" \
  "NEXT_PUBLIC_LEGAL_COMPANY_EMAIL" \
  "NEXT_PUBLIC_LEGAL_EMAIL"
check_group "support email" \
  "NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL" \
  "NEXT_PUBLIC_LEGAL_COMPANY_EMAIL" \
  "NEXT_PUBLIC_LEGAL_EMAIL"
check_group "legal last updated" "NEXT_PUBLIC_LEGAL_LAST_UPDATED"
check_group "source code URL" "NEXT_PUBLIC_SOURCE_CODE_URL"

if [[ "${#missing_entries[@]}" -gt 0 ]]; then
  echo "[check-legal-env] Missing legal env vars for APP_ENV=${app_env}:" >&2
  for entry in "${missing_entries[@]}"; do
    echo "- ${entry}" >&2
  done
  echo "[check-legal-env] Placeholders like CHANGE_ME, YOUR_*, or example.com are treated as missing." >&2
  exit 1
fi

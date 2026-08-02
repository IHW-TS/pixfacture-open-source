#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# A production Next build evaluates the legal fail-closed middleware at build
# time.  When this script starts its own disposable frontend, provide a complete
# synthetic legal identity so the browser suite exercises the application
# instead of the HTTP 503 legal-maintenance page.  Never override values passed
# by a caller and never use these defaults for an externally supplied E2E URL.
if [[ -z "${E2E_BASE_URL:-}" ]]; then
  export APP_ENV="${APP_ENV:-test}"
  export NEXT_PUBLIC_LEGAL_COMPANY_NAME="${NEXT_PUBLIC_LEGAL_COMPANY_NAME:-Entreprise CI}"
  export NEXT_PUBLIC_LEGAL_COMPANY_LEGAL_FORM="${NEXT_PUBLIC_LEGAL_COMPANY_LEGAL_FORM:-SAS}"
  export NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL="${NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL:-1 000 euros}"
  export NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS="${NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS:-1 rue du Test, 75000 Paris}"
  export NEXT_PUBLIC_LEGAL_COMPANY_EMAIL="${NEXT_PUBLIC_LEGAL_COMPANY_EMAIL:-ci@pixfacture.test}"
  export NEXT_PUBLIC_LEGAL_COMPANY_PHONE="${NEXT_PUBLIC_LEGAL_COMPANY_PHONE:-0100000000}"
  export NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR="${NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR:-Direction CI}"
  export NEXT_PUBLIC_LEGAL_COMPANY_RCS_CITY="${NEXT_PUBLIC_LEGAL_COMPANY_RCS_CITY:-Paris}"
  export NEXT_PUBLIC_LEGAL_COMPANY_RCS_NUMBER="${NEXT_PUBLIC_LEGAL_COMPANY_RCS_NUMBER:-552 100 554}"
  export NEXT_PUBLIC_LEGAL_COMPANY_VAT_NUMBER="${NEXT_PUBLIC_LEGAL_COMPANY_VAT_NUMBER:-FR43552100554}"
  export NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_NAME="${NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_NAME:-Hébergeur CI}"
  export NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_ADDRESS="${NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_ADDRESS:-2 rue du Test, 75000 Paris}"
  export NEXT_PUBLIC_LEGAL_HOSTING_PHONE="${NEXT_PUBLIC_LEGAL_HOSTING_PHONE:-0100000001}"
  export NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT_EMAIL="${NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT_EMAIL:-privacy@pixfacture.test}"
  export NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL="${NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL:-support@pixfacture.test}"
  export NEXT_PUBLIC_LEGAL_LAST_UPDATED="${NEXT_PUBLIC_LEGAL_LAST_UPDATED:-2026-07-12}"
  export NEXT_PUBLIC_SOURCE_CODE_URL="${NEXT_PUBLIC_SOURCE_CODE_URL:-https://github.com/IHW-TS/pixfacture-open-source}"
  export NEXT_PUBLIC_LEGAL_COMPANY_SIRET="${NEXT_PUBLIC_LEGAL_COMPANY_SIRET:-55210055400013}"
  export NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED="${NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED:-2026-07-12}"
  export NEXT_PUBLIC_TRUST_CENTER_LAST_UPDATED="${NEXT_PUBLIC_TRUST_CENTER_LAST_UPDATED:-2026-07-12}"
fi

if [ -f package-lock.json ]; then
  npm ci --ignore-scripts
else
  npm install --ignore-scripts
fi

if [ "${CI:-}" = "true" ]; then
  npm exec -- playwright install --with-deps
fi

npm run legal:check
npm run csp:check
npm run style:inline:check
npm run check:active-sources
CHECK_REPO_HYGIENE_SOURCE_ONLY=1 bash ../scripts/check_repo_hygiene.sh
npm run lint
npm run typecheck
npm run test:unit
npm audit --omit=dev
NEXT_TELEMETRY_DISABLED=1 npm run build

E2E_SERVER_PID=""
E2E_SERVER_LOG=""
SELF_HOSTED_E2E=0
cleanup_e2e_server() {
  if [[ -n "$E2E_SERVER_PID" ]]; then
    kill "$E2E_SERVER_PID" >/dev/null 2>&1 || true
    wait "$E2E_SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$E2E_SERVER_LOG" ]]; then
    rm -f "$E2E_SERVER_LOG"
  fi
}
trap cleanup_e2e_server EXIT

assert_self_hosted_e2e_api_is_local() {
  node <<'NODE'
const fs = require('node:fs')
const manifestPath = '.next/routes-manifest.json'
if (!fs.existsSync(manifestPath)) {
  console.error(`Manifeste Next introuvable pour le garde E2E: ${manifestPath}`)
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const rewrites = manifest.rewrites || {}
const candidates = Array.isArray(rewrites)
  ? rewrites
  : [...(rewrites.beforeFiles || []), ...(rewrites.afterFiles || []), ...(rewrites.fallback || [])]
const apiRewrite = candidates.find((item) => item && item.source === '/api/:path*')
if (!apiRewrite || !apiRewrite.destination) {
  console.error('Réécriture /api/:path* introuvable: E2E local refusé.')
  process.exit(1)
}
let parsed
try {
  parsed = new URL(String(apiRewrite.destination).replace(':path*', 'health'))
} catch {
  console.error('Destination API E2E invalide: E2E local refusé.')
  process.exit(1)
}
const host = parsed.hostname.toLowerCase().replace(/\.+$/, '')
const local = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1'
if (!local) {
  console.error(
    `E2E local refusé: le build réécrit /api vers une cible distante (${parsed.origin}). ` +
      'Utiliser une stack E2E jetable et définir E2E_BASE_URL explicitement.',
  )
  process.exit(1)
}
NODE
}

if [[ -z "${E2E_BASE_URL:-}" ]]; then
  SELF_HOSTED_E2E=1
  assert_self_hosted_e2e_api_is_local
  E2E_PORT="${E2E_PORT:-3100}"
  E2E_BASE_URL="http://127.0.0.1:${E2E_PORT}"
  E2E_SERVER_LOG="$(mktemp /tmp/pixfacture-e2e-frontend.XXXXXX.log)"
  mkdir -p .next/standalone/.next
  rm -rf .next/standalone/.next/static .next/standalone/public
  cp -R .next/static .next/standalone/.next/static
  if [[ -d public ]]; then
    cp -R public .next/standalone/public
  fi
  HOSTNAME=127.0.0.1 PORT="$E2E_PORT" node .next/standalone/server.js >"$E2E_SERVER_LOG" 2>&1 &
  E2E_SERVER_PID=$!
  export E2E_BASE_URL
  ready=0
  for _ in $(seq 1 60); do
    if curl --fail --silent --max-time 2 "$E2E_BASE_URL/" >/dev/null 2>&1; then
      ready=1
      break
    fi
    if ! kill -0 "$E2E_SERVER_PID" >/dev/null 2>&1; then
      tail -n 30 "$E2E_SERVER_LOG" >&2 || true
      exit 1
    fi
    sleep 1
  done
  if [[ "$ready" != 1 ]]; then
    tail -n 30 "$E2E_SERVER_LOG" >&2 || true
    echo "Frontend E2E local non disponible: $E2E_BASE_URL" >&2
    exit 1
  fi
fi

if [ "${E2E_FULL:-}" = "1" ]; then
  npm test
elif [ -n "${E2E_SPEC:-}" ]; then
  read -r -a e2e_specs <<<"${E2E_SPEC}"
  npm run test:e2e -- "${e2e_specs[@]}"
elif [[ "$SELF_HOSTED_E2E" = "1" ]]; then
  # The disposable frontend has no database/backend by design.  Run only the
  # browser contracts that stub every API call; real registration and document
  # flows are exercised by release.sh against the isolated Compose stack.
  npm run test:e2e -- \
    tests/e2e/session-csrf-retry.spec.ts \
    tests/e2e/csrf-retry.spec.ts \
    tests/e2e/cookie-config-401.spec.ts \
    tests/e2e/api-notice-permissions.spec.ts \
    tests/e2e/customers-empty-state.spec.ts
else
  npm run test:e2e -- \
    tests/e2e/ci-conversion-flow.spec.ts \
    tests/e2e/session-csrf-retry.spec.ts \
    tests/e2e/csrf-retry.spec.ts \
    tests/e2e/login-create-customer.spec.ts \
    tests/e2e/session-expired-draft.spec.ts \
    tests/e2e/cookie-config-401.spec.ts \
    tests/e2e/api-notice-permissions.spec.ts \
    tests/e2e/customers-empty-state.spec.ts
fi

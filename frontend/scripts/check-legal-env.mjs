const appEnv = (process.env.APP_ENV || '').trim().toLowerCase()
const prodLike = new Set(['prod', 'production', 'staging'])
const devLike = new Set(['dev', 'local', 'test'])

const parseFlag = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return fallback
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

const LOCAL_HOSTS = new Set(['localhost', 'localhost.localdomain', '127.0.0.1', '::1'])

const isLocalhostHost = (host) => {
  if (!host) return false
  const normalized = host.trim().toLowerCase().replace(/\.+$/, '')
  if (LOCAL_HOSTS.has(normalized)) return true
  if (normalized.endsWith('.localhost')) return true
  return false
}

const isProdLikeBase = (value) => {
  const trimmed = (value || '').trim()
  if (!/^https:\/\//i.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    const host = parsed.hostname || ''
    if (!host) return false
    return !isLocalhostHost(host)
  } catch {
    return false
  }
}

const baseCandidates = [
  { key: 'NEXT_PUBLIC_APP_BASE_URL', value: process.env.NEXT_PUBLIC_APP_BASE_URL },
  { key: 'NEXT_PUBLIC_SITE_URL', value: process.env.NEXT_PUBLIC_SITE_URL },
  { key: 'NEXT_PUBLIC_API_ORIGIN', value: process.env.NEXT_PUBLIC_API_ORIGIN },
]
const baseCandidate = baseCandidates.find(({ value }) => (value || '').trim())
const baseKey = baseCandidate?.key || ''
const baseValue = (baseCandidate?.value || '').trim()

if (devLike.has(appEnv) && baseValue && isProdLikeBase(baseValue)) {
  console.error(
    `[check-legal-env] APP_ENV=${appEnv} avec ${baseKey}=${baseValue} (domaine public https) est interdit.`
  )
  console.error(
    '[check-legal-env] Utilisez APP_ENV=prod|production|staging ou un base URL local (localhost/127.0.0.1).'
  )
  process.exit(1)
}

const isProdBuild = process.env.NODE_ENV === 'production'
const isProdLikeEnv = isProdBuild || prodLike.has(appEnv)

if (!isProdLikeEnv) {
  process.exit(0)
}

const bearerPersistMode = (process.env.NEXT_PUBLIC_BEARER_TOKEN_PERSIST || '').trim().toLowerCase()
if (bearerPersistMode === 'session') {
  console.error('[check-legal-env] NEXT_PUBLIC_BEARER_TOKEN_PERSIST=session est interdit en prod/staging.')
  console.error('[check-legal-env] Action: utiliser le mode cookie HttpOnly ou conserver les Bearer tokens en mémoire uniquement.')
  process.exit(1)
}

const enableEinvoicingPages = parseFlag(process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES)
const enablePdpIntegration = parseFlag(process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION)
const isMvpCommercialMode = parseFlag(process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE, isProdBuild)

if (enableEinvoicingPages && enablePdpIntegration && isMvpCommercialMode) {
  console.error('[check-legal-env] Configuration incoherente: e-invoicing pages + PDP integration actives mais MVP commercial mode actif.')
  console.error('[check-legal-env] Action: definir NEXT_PUBLIC_MVP_COMMERCIAL_MODE=off (parcours connecte) ou desactiver NEXT_PUBLIC_ENABLE_EINVOICING_PAGES / NEXT_PUBLIC_ENABLE_PDP_INTEGRATION (export-only).')
  process.exit(1)
}

const placeholderLogged = new Set()
const placeholderTokens = [
  'change_me',
  'your_',
  'todo',
  'tbd',
  'example.com',
  'date a renseigner',
  'date à renseigner',
  'a renseigner',
  'à renseigner',
  'renseigner',
  'a compléter',
  'à compléter',
  'a completer',
  'à completer',
  'non renseigne',
  'non renseigné',
  'metre_ton',
  'mettre_ton',
  'ton_',
  'ta_',
  'a_remplir',
]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SIRET_RE = /^\d{14}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const normalizeValue = (value) => (value || '').trim()

const isMissing = (value, key) => {
  const trimmed = normalizeValue(value)
  if (!trimmed) return true
  const normalized = trimmed.toLowerCase()
  const hasPlaceholder =
    trimmed.includes('<<') ||
    trimmed.includes('>>') ||
    placeholderTokens.some((token) => normalized.includes(token))
  if (hasPlaceholder && key && !placeholderLogged.has(key)) {
    console.error(`[check-legal-env] Placeholder détecté: ${key}=${trimmed}`)
    placeholderLogged.add(key)
  }
  return hasPlaceholder
}

const pickValue = (keys) => {
  for (const key of keys) {
    const value = normalizeValue(process.env[key])
    if (!isMissing(value)) return { key, value }
  }
  return null
}

const isValidEmail = (value) => EMAIL_RE.test(value)

const isValidSiret = (value) => {
  const normalized = normalizeValue(value).replace(/\s+/g, '')
  return SIRET_RE.test(normalized)
}

const isValidAddress = (value) => {
  const normalized = normalizeValue(value)
  if (normalized.length < 8) return false
  const hasDigit = /\d/.test(normalized)
  const hasLetter = /[a-zA-ZÀ-ÿ]/.test(normalized)
  return hasDigit && hasLetter
}

const isValidPhone = (value) => {
  const digits = normalizeValue(value).replace(/\D/g, '')
  return digits.length >= 6 && digits.length <= 15
}

const isValidUrl = (value) => {
  const normalized = normalizeValue(value)
  if (!normalized) return false
  if (normalized.toLowerCase().includes('example.com')) return false
  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== 'https:') return false
    if (isLocalhostHost(parsed.hostname || '')) return false
    return true
  } catch {
    return false
  }
}

const isValidIsoDate = (value) => {
  const normalized = normalizeValue(value)
  if (!DATE_RE.test(normalized)) return false
  const [yearStr, monthStr, dayStr] = normalized.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  )
}

const required = [
  { label: 'company name', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_NAME'] },
  { label: 'company legal form', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_LEGAL_FORM'] },
  { label: 'company capital', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL', 'NEXT_PUBLIC_LEGAL_COMPANY_SHARE_CAPITAL'] },
  { label: 'company address', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS', 'NEXT_PUBLIC_LEGAL_ADDRESS'] },
  { label: 'company email', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_EMAIL', 'NEXT_PUBLIC_LEGAL_EMAIL'] },
  { label: 'company phone', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_PHONE', 'NEXT_PUBLIC_CONTACT_PHONE'] },
  { label: 'publisher director', keys: ['NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR', 'NEXT_PUBLIC_LEGAL_DIRECTOR_PUBLICATION'] },
  { label: 'company rcs city', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_RCS_CITY'] },
  { label: 'company rcs number', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_RCS_NUMBER', 'NEXT_PUBLIC_LEGAL_RCS'] },
  { label: 'company VAT', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_VAT_NUMBER', 'NEXT_PUBLIC_LEGAL_VAT_NUMBER'] },
  { label: 'hosting provider name', keys: ['NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_NAME', 'NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER'] },
  { label: 'hosting provider address', keys: ['NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_ADDRESS', 'NEXT_PUBLIC_LEGAL_HOSTING_LOCATION'] },
  { label: 'hosting provider phone', keys: ['NEXT_PUBLIC_LEGAL_HOSTING_PHONE'] },
  {
    label: 'privacy contact email',
    keys: [
      'NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT_EMAIL',
      'NEXT_PUBLIC_LEGAL_DPO_EMAIL',
      'NEXT_PUBLIC_DPO_EMAIL',
      'NEXT_PUBLIC_LEGAL_COMPANY_EMAIL',
      'NEXT_PUBLIC_LEGAL_EMAIL',
    ],
  },
  {
    label: 'support email',
    keys: ['NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL', 'NEXT_PUBLIC_LEGAL_COMPANY_EMAIL', 'NEXT_PUBLIC_LEGAL_EMAIL'],
  },
  { label: 'legal last updated', keys: ['NEXT_PUBLIC_LEGAL_LAST_UPDATED'] },
  { label: 'source code URL', keys: ['NEXT_PUBLIC_SOURCE_CODE_URL'] },
  { label: 'company siret', keys: ['SUPPLIER_SIRET', 'NEXT_PUBLIC_LEGAL_COMPANY_SIRET', 'NEXT_PUBLIC_LEGAL_SIRET'] },
  { label: 'official sources last updated', keys: ['NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED'] },
  { label: 'trust center last updated', keys: ['NEXT_PUBLIC_TRUST_CENTER_LAST_UPDATED'] },
]

if (parseFlag(process.env.LEGAL_TERMS_ACCEPTANCE_REQUIRED)) {
  required.push({ label: 'terms document version', keys: ['NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS'] })
}

if (parseFlag(process.env.LEGAL_DPA_ACCEPTANCE_REQUIRED)) {
  required.push({ label: 'DPA document version', keys: ['NEXT_PUBLIC_LEGAL_DOC_VERSION_DPA'] })
  required.push({ label: 'contractual subprocessors list', keys: ['NEXT_PUBLIC_LEGAL_SUBPROCESSORS'] })
}

if (parseFlag(process.env.NEXT_PUBLIC_LEGAL_DPO_DESIGNATED)) {
  required.push({ label: 'designated DPO email', keys: ['NEXT_PUBLIC_LEGAL_DPO_EMAIL', 'NEXT_PUBLIC_DPO_EMAIL'] })
}

const missing = []

required.forEach(({ label, keys }) => {
  const values = keys.map((key) => process.env[key])
  if (values.every((value) => isMissing(value))) {
    missing.push({ label, keys })
  }
})

if (missing.length > 0) {
  console.error(`[check-legal-env] Missing legal env vars for APP_ENV=${appEnv}:`)
  missing.forEach(({ label, keys }) => {
    console.error(`- ${label}: ${keys.join(' | ')}`)
  })
  console.error('[check-legal-env] Placeholders like CHANGE_ME, YOUR_*, or example.com are treated as missing.')
  process.exit(1)
}

const validationErrors = []

const validateSubprocessors = () => {
  if (!parseFlag(process.env.LEGAL_DPA_ACCEPTANCE_REQUIRED)) return
  const picked = pickValue(['NEXT_PUBLIC_LEGAL_SUBPROCESSORS'])
  if (!picked) return
  let parsed
  try {
    parsed = JSON.parse(picked.value)
  } catch {
    validationErrors.push(`${picked.key} doit etre un JSON valide.`)
    return
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    validationErrors.push(`${picked.key} doit contenir au moins un sous-traitant.`)
    return
  }
  parsed.forEach((item, index) => {
    const name = normalizeValue(item && item.name)
    const purpose = normalizeValue(item && item.purpose)
    if (!name || !purpose) {
      validationErrors.push(`${picked.key}[${index}] doit contenir name et purpose.`)
    }
  })
}

validateSubprocessors()

const emailGroups = [
  { label: 'company email', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_EMAIL', 'NEXT_PUBLIC_LEGAL_EMAIL'] },
  {
    label: 'privacy contact email',
    keys: [
      'NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT_EMAIL',
      'NEXT_PUBLIC_LEGAL_DPO_EMAIL',
      'NEXT_PUBLIC_DPO_EMAIL',
      'NEXT_PUBLIC_LEGAL_COMPANY_EMAIL',
      'NEXT_PUBLIC_LEGAL_EMAIL',
    ],
  },
  { label: 'support email', keys: ['NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL', 'NEXT_PUBLIC_LEGAL_COMPANY_EMAIL', 'NEXT_PUBLIC_LEGAL_EMAIL'] },
  { label: 'dpo email', keys: ['NEXT_PUBLIC_LEGAL_DPO_EMAIL', 'NEXT_PUBLIC_DPO_EMAIL'] },
]

emailGroups.forEach(({ label, keys }) => {
  const picked = pickValue(keys)
  if (!picked) return
  if (!isValidEmail(picked.value)) {
    validationErrors.push(`${label} invalide: ${picked.key}=${picked.value}`)
  }
})

const addressGroups = [
  { label: 'company address', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS', 'NEXT_PUBLIC_LEGAL_ADDRESS'] },
  { label: 'hosting provider address', keys: ['NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_ADDRESS', 'NEXT_PUBLIC_LEGAL_HOSTING_LOCATION'] },
]

addressGroups.forEach(({ label, keys }) => {
  const picked = pickValue(keys)
  if (!picked) return
  if (!isValidAddress(picked.value)) {
    validationErrors.push(`${label} invalide: ${picked.key}=${picked.value}`)
  }
})

const phoneGroups = [
  { label: 'company phone', keys: ['NEXT_PUBLIC_LEGAL_COMPANY_PHONE', 'NEXT_PUBLIC_CONTACT_PHONE'] },
  { label: 'hosting provider phone', keys: ['NEXT_PUBLIC_LEGAL_HOSTING_PHONE'] },
]

phoneGroups.forEach(({ label, keys }) => {
  const picked = pickValue(keys)
  if (!picked) return
  if (!isValidPhone(picked.value)) {
    validationErrors.push(`${label} invalide: ${picked.key}=${picked.value}`)
  }
})

const siretValue = pickValue(['SUPPLIER_SIRET', 'NEXT_PUBLIC_LEGAL_COMPANY_SIRET', 'NEXT_PUBLIC_LEGAL_SIRET'])
if (siretValue && !isValidSiret(siretValue.value)) {
  validationErrors.push(`SIRET invalide: ${siretValue.key}=${siretValue.value}`)
}

const dateFields = [
  { label: 'official sources last updated', keys: ['NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED'] },
  { label: 'trust center last updated', keys: ['NEXT_PUBLIC_TRUST_CENTER_LAST_UPDATED'] },
]

dateFields.forEach(({ label, keys }) => {
  const picked = pickValue(keys)
  if (!picked) return
  if (!isValidIsoDate(picked.value)) {
    validationErrors.push(`${label} invalide (YYYY-MM-DD requis): ${picked.key}=${picked.value}`)
  }
})

const legalDocUrls = [
  { label: 'CGV PDF', key: 'NEXT_PUBLIC_LEGAL_PDF_CGV_URL' },
  { label: 'CGU PDF', key: 'NEXT_PUBLIC_LEGAL_PDF_CGU_URL' },
  { label: 'DPA PDF', key: 'NEXT_PUBLIC_LEGAL_PDF_DPA_URL' },
]

legalDocUrls.forEach(({ label, key }) => {
  const value = normalizeValue(process.env[key])
  if (!value) return
  if (isMissing(value, key)) return
  if (!isValidUrl(value)) {
    validationErrors.push(`${label} invalide: ${key}=${value}`)
  }
})

const sourceCodeUrl = pickValue(['NEXT_PUBLIC_SOURCE_CODE_URL'])
if (sourceCodeUrl && !isValidUrl(sourceCodeUrl.value)) {
  validationErrors.push(`source code URL invalide: ${sourceCodeUrl.key}=${sourceCodeUrl.value}`)
}

if (validationErrors.length > 0) {
  console.error(`[check-legal-env] Invalid legal env values for APP_ENV=${appEnv}:`)
  validationErrors.forEach((err) => console.error(`- ${err}`))
  process.exit(1)
}

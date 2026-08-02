import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKIP_CHECK = process.env.SKIP_LINK_CHECK === '1'

if (SKIP_CHECK) {
  console.log('SKIP_LINK_CHECK=1, skipping official links check.')
  process.exit(0)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const officialLinksPath = path.resolve(__dirname, '../src/lib/officialLinks.ts')
const allowlistPath = path.resolve(__dirname, '../../lychee.allowlist.txt')

const loadAllowlist = async () => {
  try {
    const raw = await fs.readFile(allowlistPath, 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  } catch {
    return []
  }
}

const matchAllowlist = (url, allowlist) => {
  return allowlist.some((entry) => {
    if (entry.startsWith('/') && entry.endsWith('/') && entry.length > 1) {
      try {
        return new RegExp(entry.slice(1, -1)).test(url)
      } catch {
        return false
      }
    }
    return url === entry
  })
}

const extractUrls = (content) => {
  const regex = /OFFICIAL_[A-Z0-9_]+_URL\s*=\s*\n?\s*['"]([^'"]+)['"]/g
  const matches = [...content.matchAll(regex)]
  return matches.map((match) => match[1])
}

const content = await fs.readFile(officialLinksPath, 'utf8')
const urls = extractUrls(content)

if (urls.length === 0) {
  console.error('No official URLs found in officialLinks.ts')
  process.exit(1)
}

const allowlist = await loadAllowlist()
const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
const timeoutMs = 15000
let hasFailure = false

for (const url of urls) {
  if (matchAllowlist(url, allowlist)) {
    console.log(`Skip (allowlist): ${url}`)
    continue
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': userAgent },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (res.status >= 400) {
      console.error(`FAIL ${res.status} ${url}`)
      hasFailure = true
    } else {
      console.log(`OK ${res.status} ${url}`)
    }
  } catch (err) {
    console.error(`ERROR ${url} ${err instanceof Error ? err.message : String(err)}`)
    hasFailure = true
  } finally {
    clearTimeout(timer)
  }
}

if (hasFailure) {
  process.exitCode = 1
}

import { defineConfig } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000'
const parsedBaseURL = new URL(baseURL)
const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
if (!localHosts.has(parsedBaseURL.hostname) && process.env.E2E_ALLOW_REMOTE_TARGET !== '1') {
  throw new Error(
    `Cible E2E distante refusée (${parsedBaseURL.origin}). Définir E2E_ALLOW_REMOTE_TARGET=1 explicitement.`,
  )
}
const ignoreHTTPSErrors =
  process.env.E2E_IGNORE_HTTPS_ERRORS === '1' ||
  process.env.E2E_IGNORE_HTTPS_ERRORS === 'true' ||
  baseURL.startsWith('https://localhost')

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL,
    ignoreHTTPSErrors,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})

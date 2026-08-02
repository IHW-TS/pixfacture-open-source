const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const createSessionStorage = () => {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
    clear: () => { store.clear() },
  }
}

const loadAuthModule = (env, storage) => {
  const sourcePath = path.join(__dirname, '../../src/lib/auth.ts')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  }).outputText

  const module = { exports: {} }
  const sandbox = {
    module,
    exports: module.exports,
    process: { env },
    console,
    window: { sessionStorage: storage },
  }
  vm.createContext(sandbox)
  const script = new vm.Script(compiled, { filename: 'auth.ts' })
  script.runInContext(sandbox)
  return module.exports
}

test('loads tokens from sessionStorage when persist=session', () => {
  const storage = createSessionStorage()
  storage.setItem('access_token', 'access123')
  storage.setItem('refresh_token', 'refresh123')
  const auth = loadAuthModule(
    {
      NODE_ENV: 'development',
      APP_ENV: 'local',
      NEXT_PUBLIC_AUTH_COOKIE_MODE: 'false',
      NEXT_PUBLIC_BEARER_TOKEN_PERSIST: 'session',
    },
    storage,
  )
  assert.equal(auth.getAccessToken(), 'access123')
  assert.equal(auth.getRefreshToken(), 'refresh123')
})

test('persists tokens when persist flag is set', () => {
  const storage = createSessionStorage()
  const auth = loadAuthModule(
    {
      NODE_ENV: 'development',
      APP_ENV: 'local',
      NEXT_PUBLIC_AUTH_COOKIE_MODE: 'false',
      NEXT_PUBLIC_BEARER_TOKEN_PERSIST: 'session',
    },
    storage,
  )
  auth.setAuthTokens({ accessToken: 'acc', refreshToken: 'ref', persist: true })
  assert.equal(storage.getItem('access_token'), 'acc')
  assert.equal(storage.getItem('refresh_token'), 'ref')
})

test('clearAuthTokens removes persisted tokens', () => {
  const storage = createSessionStorage()
  storage.setItem('access_token', 'acc')
  storage.setItem('refresh_token', 'ref')
  const auth = loadAuthModule(
    {
      NODE_ENV: 'development',
      APP_ENV: 'local',
      NEXT_PUBLIC_AUTH_COOKIE_MODE: 'false',
      NEXT_PUBLIC_BEARER_TOKEN_PERSIST: 'session',
    },
    storage,
  )
  auth.clearAuthTokens()
  assert.equal(storage.getItem('access_token'), null)
  assert.equal(storage.getItem('refresh_token'), null)
})

test('rejects session token persistence in prod-like runtime', () => {
  const storage = createSessionStorage()
  assert.throws(
    () => loadAuthModule(
      {
        NODE_ENV: 'production',
        APP_ENV: 'production',
        NEXT_PUBLIC_AUTH_COOKIE_MODE: 'false',
        NEXT_PUBLIC_BEARER_TOKEN_PERSIST: 'session',
      },
      storage,
    ),
    /NEXT_PUBLIC_BEARER_TOKEN_PERSIST=session est interdit/,
  )
})

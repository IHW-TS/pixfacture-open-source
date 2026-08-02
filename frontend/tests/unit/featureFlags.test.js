const test = require('node:test')
const assert = require('node:assert/strict')

const loadFlags = () => {
  const path = require.resolve('../../src/lib/featureFlags')
  delete require.cache[path]
  return require(path)
}

test('isMvpCommercialMode defaults to on in production when e-invoicing is disabled', () => {
  const prevNodeEnv = process.env.NODE_ENV
  const prevFlag = process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE
  const prevEinvoicing = process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES
  const prevPdp = process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION
  process.env.NODE_ENV = 'production'
  delete process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE
  delete process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES
  delete process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION
  const flags = loadFlags()
  assert.equal(flags.isMvpCommercialMode, true)
  process.env.NODE_ENV = prevNodeEnv
  if (prevFlag === undefined) {
    delete process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE
  } else {
    process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE = prevFlag
  }
  if (prevEinvoicing === undefined) {
    delete process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES
  } else {
    process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES = prevEinvoicing
  }
  if (prevPdp === undefined) {
    delete process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION
  } else {
    process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION = prevPdp
  }
})

test('isMvpCommercialMode defaults to off when e-invoicing is enabled in production', () => {
  const prevNodeEnv = process.env.NODE_ENV
  const prevFlag = process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE
  const prevEinvoicing = process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES
  const prevPdp = process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION
  process.env.NODE_ENV = 'production'
  delete process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE
  process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES = 'true'
  delete process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION
  const flags = loadFlags()
  assert.equal(flags.isMvpCommercialMode, false)
  process.env.NODE_ENV = prevNodeEnv
  if (prevFlag === undefined) {
    delete process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE
  } else {
    process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE = prevFlag
  }
  if (prevEinvoicing === undefined) {
    delete process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES
  } else {
    process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES = prevEinvoicing
  }
  if (prevPdp === undefined) {
    delete process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION
  } else {
    process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION = prevPdp
  }
})

test('isMvpCommercialMode respects explicit on/off', () => {
  const prevNodeEnv = process.env.NODE_ENV
  const prevFlag = process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE
  const prevEinvoicing = process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES
  const prevPdp = process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION
  process.env.NODE_ENV = 'development'
  process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE = 'on'
  delete process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES
  delete process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION
  let flags = loadFlags()
  assert.equal(flags.isMvpCommercialMode, true)
  process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE = 'off'
  flags = loadFlags()
  assert.equal(flags.isMvpCommercialMode, false)
  process.env.NODE_ENV = prevNodeEnv
  if (prevFlag === undefined) {
    delete process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE
  } else {
    process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE = prevFlag
  }
  if (prevEinvoicing === undefined) {
    delete process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES
  } else {
    process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES = prevEinvoicing
  }
  if (prevPdp === undefined) {
    delete process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION
  } else {
    process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION = prevPdp
  }
})

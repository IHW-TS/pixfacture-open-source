const test = require('node:test')
const assert = require('node:assert/strict')

const { getComplianceCopy } = require('../../src/lib/complianceClaims')

const withMutedWarn = (fn) => {
  const prevWarn = console.warn
  console.warn = () => {}
  try {
    return fn()
  } finally {
    console.warn = prevWarn
  }
}

test('export_only copy does not mention solution compatible', () => {
  const copy = getComplianceCopy('export_only', { allowed_claims: ['export_only'] })
  assert.equal(copy.level, 'export_only')
  assert.equal(copy.headline.includes('solution compatible'), false)
})

test('compatible copy mentions solution compatible when allowed', () => {
  const copy = getComplianceCopy('compatible', { allowed_claims: ['compatible'] })
  assert.equal(copy.level, 'compatible')
  assert.equal(copy.headline.includes('solution compatible'), true)
})

test('partnered copy includes mandate disclaimer when required', () => {
  const copy = getComplianceCopy('partnered', {
    allowed_claims: ['partnered'],
    mandate_required: true,
  })
  assert.equal(copy.level, 'partnered')
  assert.equal(copy.headline.includes('solution compatible'), true)
  assert.equal(copy.disclaimers.join(' ').toLowerCase().includes('contrat/mandat'), true)
})

test('compatible is downgraded when not allowed', () => {
  const copy = withMutedWarn(() =>
    getComplianceCopy('compatible', { allowed_claims: ['export_only'] })
  )
  assert.equal(copy.level, 'export_only')
  assert.equal(copy.headline.includes('solution compatible'), false)
})

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeSubscriptionStatus,
  shouldShowSubscriptionBanner,
} = require('../../src/lib/subscriptionBanner')

test('normalizeSubscriptionStatus trims and lowercases', () => {
  assert.equal(normalizeSubscriptionStatus(' ACTIVE '), 'active')
  assert.equal(normalizeSubscriptionStatus(null), '')
  assert.equal(normalizeSubscriptionStatus(''), '')
})

test('shouldShowSubscriptionBanner hides when status is empty', () => {
  assert.equal(shouldShowSubscriptionBanner(null), false)
  assert.equal(shouldShowSubscriptionBanner(''), false)
  assert.equal(shouldShowSubscriptionBanner('   '), false)
})

test('shouldShowSubscriptionBanner hides for active/trialing', () => {
  assert.equal(shouldShowSubscriptionBanner('active'), false)
  assert.equal(shouldShowSubscriptionBanner('trialing'), false)
  assert.equal(shouldShowSubscriptionBanner('Active'), false)
})

test('shouldShowSubscriptionBanner shows for inactive statuses', () => {
  assert.equal(shouldShowSubscriptionBanner('past_due'), true)
  assert.equal(shouldShowSubscriptionBanner('canceled'), true)
})

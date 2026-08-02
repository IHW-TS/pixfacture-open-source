const test = require('node:test')
const assert = require('node:assert/strict')

const loadTimeline = () => {
  const path = require.resolve('../../src/lib/complianceTimeline')
  delete require.cache[path]
  return require(path)
}

const withEnv = (updates, fn) => {
  const prev = {
    APP_ENV: process.env.APP_ENV,
    NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED: process.env.NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED,
  }
  if ('APP_ENV' in updates) {
    if (updates.APP_ENV === undefined) {
      delete process.env.APP_ENV
    } else {
      process.env.APP_ENV = updates.APP_ENV
    }
  }
  if ('NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED' in updates) {
    if (updates.NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED === undefined) {
      delete process.env.NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED
    } else {
      process.env.NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED = updates.NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED
    }
  }
  try {
    return fn()
  } finally {
    if (prev.APP_ENV === undefined) {
      delete process.env.APP_ENV
    } else {
      process.env.APP_ENV = prev.APP_ENV
    }
    if (prev.NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED === undefined) {
      delete process.env.NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED
    } else {
      process.env.NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED = prev.NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED
    }
  }
}

test('banniere visible si sources manquantes en prod-like', () => {
  withEnv({ APP_ENV: 'production', NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED: undefined }, () => {
    const timeline = loadTimeline()
    assert.equal(timeline.sourcesLastUpdatedAvailable, false)
    assert.equal(timeline.showSourcesUpdateBanner, true)
    assert.equal(timeline.sourcesUpdateBannerLabel, 'Sources officielles non renseignées')
  })
})

test('banniere visible si sources trop anciennes', () => {
  const prevNow = Date.now
  Date.now = () => new Date('2024-04-15T00:00:00Z').getTime()
  try {
    withEnv({ APP_ENV: 'production', NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED: '2024-01-01' }, () => {
      const timeline = loadTimeline()
      assert.equal(timeline.sourcesLastUpdatedAvailable, true)
      assert.equal(timeline.sourcesLastUpdatedStale, true)
      assert.equal(timeline.showSourcesUpdateBanner, true)
      assert.equal(
        timeline.sourcesUpdateBannerLabel,
        'Sources officielles possiblement périmées (mise à jour > 90j)'
      )
    })
  } finally {
    Date.now = prevNow
  }
})

test('banniere masquee si sources recentes', () => {
  const prevNow = Date.now
  Date.now = () => new Date('2024-04-15T00:00:00Z').getTime()
  try {
    withEnv({ APP_ENV: 'production', NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED: '2024-03-15' }, () => {
      const timeline = loadTimeline()
      assert.equal(timeline.sourcesLastUpdatedAvailable, true)
      assert.equal(timeline.sourcesLastUpdatedStale, false)
      assert.equal(timeline.showSourcesUpdateBanner, false)
      assert.equal(timeline.sourcesUpdateBannerLabel, '')
    })
  } finally {
    Date.now = prevNow
  }
})

test('calendrier reforme calcule les delais depuis la date courante', () => {
  const { buildReformTimelineState } = loadTimeline()
  const state = buildReformTimelineState(new Date('2026-07-10T00:00:00Z'))

  assert.equal(state.currentDateLabel, 'Juil. 2026')
  assert.equal(state.firstDeadlinePassed, false)
  assert.equal(state.firstDeadlineBadge, '~2 mois')
  assert.equal(state.secondDeadlineBadge, '~14 mois')
  assert.match(state.intro, /1er septembre 2026/)
  assert.match(state.intro, /moins de 2 mois/)
  assert.ok(state.progressPercent >= 65 && state.progressPercent <= 75)
})

test('calendrier reforme bascule les echeances deja entrees en vigueur', () => {
  const { buildReformTimelineState } = loadTimeline()
  const betweenDeadlines = buildReformTimelineState(new Date('2026-09-02T00:00:00Z'))
  assert.equal(betweenDeadlines.firstDeadlinePassed, true)
  assert.equal(betweenDeadlines.secondDeadlinePassed, false)
  assert.equal(betweenDeadlines.firstDeadlineBadge, 'En vigueur')
  assert.match(betweenDeadlines.intro, /PME et micro-entreprises/)

  const afterBothDeadlines = buildReformTimelineState(new Date('2027-09-02T00:00:00Z'))
  assert.equal(afterBothDeadlines.firstDeadlinePassed, true)
  assert.equal(afterBothDeadlines.secondDeadlinePassed, true)
  assert.equal(afterBothDeadlines.secondDeadlineBadge, 'En vigueur')
  assert.match(afterBothDeadlines.intro, /sont en vigueur/)
  assert.equal(afterBothDeadlines.progressPercent, 100)
})

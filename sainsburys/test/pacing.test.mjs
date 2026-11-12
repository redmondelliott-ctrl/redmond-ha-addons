import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LoginGuard, sessionAction } from '../src/pacing.mjs'

const MIN = 60_000
const now = 1_800_000_000_000

test('sessionAction leaves a fresh session alone', () => {
  assert.equal(sessionAction({ now, expiresAt: now + 3 * 60 * MIN, pageAt: now - 10 * MIN }), 'none')
  assert.equal(sessionAction({ now, expiresAt: 0, pageAt: now - 10 * MIN }), 'none')
})

test('sessionAction logs in when the cookie is gone', () => {
  assert.equal(sessionAction({ now, hasToken: false, pageAt: now }), 'login')
})

test('sessionAction reopens the site when the login runs out soon or the page is stale', () => {
  assert.equal(sessionAction({ now, expiresAt: now + 20 * MIN, pageAt: now - 10 * MIN }), 'reload')
  assert.equal(sessionAction({ now, expiresAt: now + 5 * MIN, pageAt: now - 10 * MIN }), 'reload')
  assert.equal(sessionAction({ now, expiresAt: 0, pageAt: now - 45 * MIN }), 'reload')
  assert.equal(sessionAction({ now, expiresAt: 0, pageAt: 0 }), 'reload')
})

test('sessionAction logs in when a reload did not renew the login', () => {
  assert.equal(sessionAction({ now, expiresAt: now + 5 * MIN, pageAt: now - 1 * MIN }), 'login')
  assert.equal(sessionAction({ now, expiresAt: now + 20 * MIN, pageAt: now - 1 * MIN }), 'reload')
})

test('LoginGuard.remaining counts attempts left and is 0 while cooling down', () => {
  const g = new LoginGuard('/nonexistent/dir/login.json', { max: 4 })
  assert.equal(g.remaining(now), 4)
  g.begin(now)
  g.begin(now + 1)
  assert.equal(g.remaining(now + 2), 2)
  g.failed(now + 2)
  assert.equal(g.remaining(now + 3), 0)
})

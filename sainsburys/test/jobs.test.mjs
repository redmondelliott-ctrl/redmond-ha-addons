import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addItems, searchQueries } from '../src/jobs.mjs'

test('search queries are trimmed, unique and capped', () => {
  assert.deepEqual(searchQueries({ search: [' chicken  breast ', 'chicken breast', '', null, 'leeks'] }), ['chicken breast', 'leeks'])
  assert.equal(searchQueries({ search: Array.from({ length: 30 }, (_, i) => `x${i}`) }).length, 12)
  assert.deepEqual(searchQueries({}), [])
})

test('items to add are merged, clamped and checked', () => {
  assert.deepEqual(addItems({ items: [{ uid: '123', quantity: 2 }, { uid: '123' }, { uid: 'bad uid!' }, { uid: '9', quantity: 500 }] }), [
    { uid: '123', quantity: 3 },
    { uid: '9', quantity: 20 },
  ])
  assert.deepEqual(addItems({ uid: '1' }), [])
})

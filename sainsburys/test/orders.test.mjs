import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dateOf, findItems, findOrders, money, shape } from '../src/orders.mjs'
import { Backoff, LoginGuard, looksBlocked } from '../src/pacing.mjs'

test('money and dates', () => {
  assert.equal(money('£12.30'), 12.3)
  assert.equal(money({ amount: '4.5' }), 4.5)
  assert.equal(money('free'), null)
  assert.equal(money(-1), null)
  assert.equal(dateOf('2026-09-03T18:00:00+01:00'), '2026-09-03T17:00:00.000Z')
  assert.equal(dateOf('03/09/2026'), '2026-09-03T12:00:00.000Z')
  assert.equal(dateOf(1788000000), new Date(1788000000 * 1000).toISOString())
  assert.equal(dateOf('soon'), null)
})

test('finds orders in a snake_case list response', () => {
  const json = {
    controls: { page: { size: 10, active: 1 } },
    orders: [
      { order_uid: '1234567', status: 'DELIVERED', slot: { start_time: '2026-09-03T18:00:00+01:00', end_time: 'x' }, total: 84.2, item_count: 31, placed_date: '2026-09-01T10:00:00Z' },
      { order_uid: '1234568', status: { name: 'Placed' }, slot: { start_time: '2026-09-10T08:00:00+01:00' }, total: '£12.00' },
    ],
  }
  assert.deepEqual(findOrders(json), [
    { uid: '1234567', placedAt: '2026-09-01T10:00:00.000Z', slotAt: '2026-09-03T17:00:00.000Z', status: 'DELIVERED', total: 84.2, itemCount: 31 },
    { uid: '1234568', placedAt: null, slotAt: '2026-09-10T07:00:00.000Z', status: 'Placed', total: 12, itemCount: null },
  ])
})

test('finds orders in a camelCase response', () => {
  const json = { data: { results: [{ orderNumber: 'ABC123', orderDate: '2026-08-01', deliverySlot: { startDate: '2026-08-02T09:00:00Z' }, orderTotal: { amount: 50 } }] } }
  assert.equal(findOrders(json)[0].total, 50)
  assert.equal(findOrders(json)[0].slotAt, '2026-08-02T09:00:00.000Z')
  assert.deepEqual(findOrders({ products: [{ id: '1', name: 'x' }] }), [])
})

test('finds order lines', () => {
  const json = {
    order: {
      order_uid: '1',
      order_items: [
        { quantity: 2, sub_total: 2.2, product: { product_uid: '7947559', name: 'Bananas', image: 'https://img/x.jpg' } },
        { quantity: '1', product: { sku: 99, name: 'Milk', retail_price: { price: 1.55 } } },
        { name: 'Loose carrots', qty: 0.45, unit_price: 1 },
      ],
    },
  }
  assert.deepEqual(findItems(json), [
    { uid: '7947559', name: 'Bananas', qty: 2, price: 2.2, image: 'https://img/x.jpg' },
    { uid: '99', name: 'Milk', qty: 1, price: 1.55, image: null },
    { uid: null, name: 'Loose carrots', qty: 0.45, price: 0.45, image: null },
  ])
  assert.deepEqual(shape({ a: [{ b: 1 }] }), { a: [{ b: 'number' }, '×1'] })
})

test('block detection', () => {
  assert.equal(looksBlocked({ status: 429 }), true)
  assert.equal(looksBlocked({ status: 403, text: '<h1>Access Denied</h1> Reference #18.abc' }), true)
  assert.equal(looksBlocked({ status: 403, text: '{"errors":[{"code":"UNAUTHORISED"}]}' }), false)
  assert.equal(looksBlocked({ status: 200, title: 'Groceries' }), false)
})

test('backoff and login guard', () => {
  const b = new Backoff([1000, 5000])
  assert.ok(b.fail() <= 1150)
  assert.ok(b.fail() >= 4250)
  assert.ok(b.fail() >= 4250)
  const g = new LoginGuard('/nonexistent/dir/x.json', { max: 2, windowMs: 1000, failWaits: [100] })
  g.begin(0)
  g.begin(10)
  assert.throws(() => g.begin(20), /Waiting until/)
  assert.doesNotThrow(() => g.begin(1001))
  g.failed(1001)
  assert.equal(g.nextAllowed(1050) > 0, true)
})

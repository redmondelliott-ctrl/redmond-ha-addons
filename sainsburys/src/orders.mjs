// Reading orders out of whatever JSON the Sainsbury's website loads for its
// "My orders" pages. Their API isn't documented and changes, so instead of
// hard-coding one response shape this looks for anything order-shaped or
// item-shaped and maps the common field names. Pure functions, no I/O.

const ID_KEYS = ['order_uid', 'orderUid', 'order_id', 'orderId', 'order_number', 'orderNumber', 'order_reference', 'orderReference', 'reference', 'uid', 'id']
const TOTAL_KEYS = ['total', 'order_total', 'orderTotal', 'total_price', 'totalPrice', 'grand_total', 'grandTotal', 'total_cost', 'totalCost', 'amount', 'total_amount', 'totalAmount', 'price', 'sub_total', 'subTotal', 'subtotal']
const COUNT_KEYS = ['item_count', 'itemCount', 'number_of_items', 'numberOfItems', 'total_items', 'totalItems', 'items_count', 'itemsCount', 'total_quantity', 'totalQuantity']
const PLACED_RE = /^(placed|created|ordered|submitted|order_?date|date_?placed|placed_?(at|date|time|on))/i
const SLOT_RE = /(slot|delivery|collection|fulfil|fulfill)/i
const SLOT_INNER = ['start_time', 'startTime', 'start', 'from', 'date', 'start_date', 'startDate', 'slot_start', 'slotStart', 'time']

const NAME_KEYS = ['name', 'product_name', 'productName', 'title', 'description']
const QTY_KEYS = ['quantity', 'qty', 'ordered_quantity', 'orderedQuantity', 'quantity_ordered', 'count']
const LINE_KEYS = ['sub_total', 'subTotal', 'subtotal', 'total_price', 'totalPrice', 'line_total', 'lineTotal', 'total', 'cost', 'item_total', 'itemTotal']
const UNIT_KEYS = ['unit_price', 'unitPrice', 'price', 'retail_price', 'retailPrice']

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** £ amount from 12.3, "12.30", "£12.30", { amount: 12.3 }, { price: "12.30" }. */
export function money(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v < 100000 ? Math.round(v * 100) / 100 : null
  if (typeof v === 'string') {
    const m = /^\s*£?\s*(\d+(?:\.\d+)?)\s*$/.exec(v)
    return m ? money(Number(m[1])) : null
  }
  if (isObj(v)) {
    for (const k of ['amount', 'value', 'price', 'total', 'gross']) if (k in v) return money(v[k])
  }
  return null
}

/** ISO date string from a date-ish value (string, epoch ms/s), or null. */
export function dateOf(v) {
  let d = null
  if (typeof v === 'number') d = new Date(v < 1e11 ? v * 1000 : v)
  else if (typeof v === 'string' && /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/.test(v)) {
    const uk = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v)
    d = uk ? new Date(Date.UTC(+uk[3], +uk[2] - 1, +uk[1], 12)) : new Date(v)
  }
  if (!d || !Number.isFinite(d.getTime())) return null
  const y = d.getUTCFullYear()
  return y >= 2000 && y <= 2100 ? d.toISOString() : null
}

function first(o, keys, fn) {
  for (const k of keys) {
    if (o[k] == null) continue
    const v = fn(o[k])
    if (v != null) return v
  }
  return null
}

function idOf(o) {
  return first(o, ID_KEYS, (v) => (typeof v === 'string' || typeof v === 'number') && /^[A-Za-z0-9_-]{3,40}$/.test(String(v)) ? String(v) : null)
}

function slotOf(o) {
  for (const [k, v] of Object.entries(o)) {
    if (!SLOT_RE.test(k)) continue
    const direct = dateOf(v)
    if (direct) return direct
    if (isObj(v)) {
      const inner = first(v, SLOT_INNER, dateOf)
      if (inner) return inner
    }
  }
  return null
}

function placedOf(o) {
  for (const [k, v] of Object.entries(o)) if (PLACED_RE.test(k)) {
    const d = dateOf(v)
    if (d) return d
  }
  return null
}

function statusOf(o) {
  const v = o.status ?? o.order_status ?? o.orderStatus ?? o.state
  if (typeof v === 'string') return v
  if (isObj(v)) return first(v, ['name', 'label', 'description', 'code', 'value'], (s) => (typeof s === 'string' ? s : null))
  return null
}

function countOf(o) {
  return first(o, COUNT_KEYS, (v) => {
    const n = Number(v)
    return Number.isInteger(n) && n >= 0 ? n : null
  })
}

/** One order summary from an order-shaped object, or null. */
export function toOrder(o) {
  if (!isObj(o)) return null
  const uid = idOf(o)
  if (!uid) return null
  const placedAt = placedOf(o)
  const slotAt = slotOf(o)
  const total = first(o, TOTAL_KEYS, money)
  if (!placedAt && !slotAt) return null // anything without a date isn't an order
  return { uid, placedAt, slotAt, status: statusOf(o), total, itemCount: countOf(o) }
}

function* arrays(node, depth = 0) {
  if (depth > 8) return
  if (Array.isArray(node)) {
    yield node
    for (const v of node) yield* arrays(v, depth + 1)
  } else if (isObj(node)) {
    for (const v of Object.values(node)) yield* arrays(v, depth + 1)
  }
}

/** The biggest list of orders anywhere in a JSON response. */
export function findOrders(json) {
  let best = []
  for (const arr of arrays(json)) {
    const objs = arr.filter(isObj)
    if (!objs.length || objs.length < arr.length / 2) continue
    const orders = objs.map(toOrder).filter(Boolean)
    if (orders.length > best.length && orders.length >= objs.length / 2) best = orders
  }
  const seen = new Set()
  return best.filter((o) => !seen.has(o.uid) && seen.add(o.uid))
}

function nameOf(o) {
  const own = first(o, NAME_KEYS, (v) => (typeof v === 'string' && v.trim() ? v.trim() : null))
  if (own) return own
  return isObj(o.product) ? first(o.product, NAME_KEYS, (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)) : null
}

function qtyOf(o) {
  return first(o, QTY_KEYS, (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 && n < 1000 ? n : null
  })
}

/** One order line from an item-shaped object, or null. */
export function toItem(o) {
  if (!isObj(o)) return null
  const name = nameOf(o)
  const qty = qtyOf(o)
  if (!name || !qty) return null
  const p = isObj(o.product) ? o.product : {}
  const uid = first({ ...p, ...o }, ['product_uid', 'productUid', 'sku', 'product_id', 'productId'], (v) => (typeof v === 'string' || typeof v === 'number') && /^[A-Za-z0-9_-]{1,40}$/.test(String(v)) ? String(v) : null)
  let price = first(o, LINE_KEYS, money)
  if (price == null) {
    const unit = first(o, UNIT_KEYS, money) ?? first(p, UNIT_KEYS, money)
    if (unit != null) price = Math.round(unit * qty * 100) / 100
  }
  const img = [o.image, o.image_url, o.imageUrl, p.image, p.image_url, p.imageUrl, p.image_thumbnail, p.assets?.plp_image].find((s) => typeof s === 'string' && s.startsWith('https://'))
  return { uid, name: name.slice(0, 200), qty, price, image: img ?? null }
}

/** The biggest list of order lines anywhere in a JSON response. */
export function findItems(json) {
  let best = []
  for (const arr of arrays(json)) {
    const objs = arr.filter(isObj)
    if (!objs.length) continue
    const items = objs.map(toItem).filter(Boolean)
    if (items.length > best.length && items.length >= objs.length / 2) best = items
  }
  return best
}

/** Key outline of a JSON value (no values), for logs when parsing fails. */
export function shape(v, depth = 0) {
  if (depth > 3) return '…'
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `×${v.length}`] : []
  if (isObj(v)) return Object.fromEntries(Object.keys(v).slice(0, 25).map((k) => [k, shape(v[k], depth + 1)]))
  return typeof v
}

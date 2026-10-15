// Reads the meal jobs Famz sends (pure, so it can be tested).

const MAX_SEARCHES = 12
const MAX_ITEMS = 40

/** Words to look up for a "refresh" job carrying `search` (ingredient names). */
export function searchQueries(payload) {
  const list = Array.isArray(payload?.search) ? payload.search : []
  const out = []
  for (const q of list) {
    const text = String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= MAX_SEARCHES) break
  }
  return out
}

/** Products and quantities for an "add" job carrying several `items` (a meal's shopping). */
export function addItems(payload) {
  const list = Array.isArray(payload?.items) ? payload.items : []
  const byUid = new Map()
  for (const it of list) {
    const uid = String(it?.uid ?? '').trim()
    if (!/^[\w-]{1,40}$/.test(uid)) continue
    const qty = Math.max(1, Math.min(20, Math.floor(Number(it?.quantity) || 1)))
    byUid.set(uid, Math.min(20, (byUid.get(uid) ?? 0) + qty))
    if (byUid.size >= MAX_ITEMS) break
  }
  return [...byUid].map(([uid, quantity]) => ({ uid, quantity }))
}

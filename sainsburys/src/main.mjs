import fs from 'node:fs'
import { Cloud } from './cloud.mjs'
import { Backoff, BlockedError, isDaytime, jitter, LoginCooldownError, pause, sleep, ukTime } from './pacing.mjs'
import { Sainsburys, setStore } from './sainsburys.mjs'
import { startServer } from './server.mjs'
import { log, onStatus, setStatus, status, submitCode } from './status.mjs'

const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))
startServer(8099)

const MIN = 60_000
const HOUR = 60 * MIN
const JOB_TIMEOUT_MS = 3 * MIN
const ORDERS_TIMEOUT_MS = 15 * MIN
const CODE_TIMEOUT_MS = 12 * MIN
const STATE_FILE = '/data/state.json'
const errorText = (e) => (e instanceof Error ? e.message : String(e))

if (!options.email || !options.password) {
  setStatus({ state: 'needs_config', message: 'Enter your Sainsbury’s email and password in the Configuration tab, then restart.' })
} else if (!options.connector_token) {
  setStatus({ state: 'needs_config', message: 'Paste the connector token from Famz (Settings → Sainsbury’s) into the Configuration tab, then restart.' })
} else {
  run().catch((e) => setStatus({ state: 'error', message: errorText(e) }))
}
setInterval(() => {}, 1 << 30)

/** When things last happened; kept across restarts so a restart doesn't trigger a burst of requests. */
function loadState() {
  try {
    return { lastFavourites: 0, lastOrders: 0, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }
  } catch {
    return { lastFavourites: 0, lastOrders: 0 }
  }
}
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state))
  } catch {
    // not fatal
  }
}

/**
 * Background schedule. Irregular gaps, frequent in the day and rare at
 * night, like a household that checks the trolley now and then, never a
 * metronome hitting the site every few minutes around the clock.
 */
const keepAliveGap = () => (isDaytime() ? jitter(12 * MIN, 25 * MIN) : jitter(70 * MIN, 130 * MIN))
const favouritesGap = () => jitter(5 * HOUR, 8 * HOUR)
const ordersGap = () => jitter(20 * HOUR, 28 * HOUR)

async function run() {
  if (options.store_number) setStore(options.store_number)
  const cloud = new Cloud(options.connector_token)
  const sb = new Sainsburys(options.email, options.password)
  const saved = loadState()

  // Mirror our state to the app (debounced so bursts become one report).
  let pending = null
  onStatus(() => {
    clearTimeout(pending)
    pending = setTimeout(() => cloud.report({ status: appStatus() }), 300)
  })

  // Work happens one job at a time; the poll loop only queues it.
  const queue = []
  let wake = null
  const enqueue = (job) => {
    queue.push(job)
    wake?.()
  }

  // Stop everything for a while when Sainsbury's pushes back.
  let pausedUntil = 0
  let pauseReason = ''
  const blocked = new Backoff([45 * MIN, 2 * HOUR, 4 * HOUR, 8 * HOUR])
  const trouble = new Backoff([2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN, HOUR])
  const isPaused = () => Date.now() < pausedUntil

  pollLoop(cloud, enqueue)

  await sb.start()
  // Don't hit the site the instant the add-on starts (restarts would make a pattern).
  let nextCheck = Date.now() + jitter(20_000, 90_000)
  let nextFavourites = saved.lastFavourites ? saved.lastFavourites + favouritesGap() : nextCheck
  let nextOrders = saved.lastOrders ? saved.lastOrders + ordersGap() : nextCheck + jitter(3 * MIN, 10 * MIN)

  for (;;) {
    if (!queue.length) {
      await new Promise((r) => {
        wake = r
        setTimeout(r, 30_000)
      })
      wake = null
    }
    const job = queue.shift() ?? null
    if (job && isPaused()) {
      // Don't touch Sainsbury's; tell the app why.
      if (job.id) await cloud.report({ jobId: job.id, ok: false, error: `Paused until ${ukTime(pausedUntil)} (${pauseReason})` })
      continue
    }
    if (!job && (isPaused() || Date.now() < nextCheck)) continue
    try {
      // A text code can legitimately take a while, and so can an order
      // sync; anything else that runs this long is a hang.
      await hangGuard(work(job), job?.kind === 'orders' || (!job && nextOrders <= Date.now()) ? ORDERS_TIMEOUT_MS : JOB_TIMEOUT_MS)
      trouble.reset()
      blocked.reset()
    } catch (e) {
      log(`Job ${job?.kind ?? 'check'} failed: ${errorText(e)}`)
      if (job?.id) await cloud.report({ jobId: job.id, ok: false, error: errorText(e) })
      if (e instanceof BlockedError || e instanceof LoginCooldownError) {
        pausedUntil = e instanceof LoginCooldownError ? e.until : Date.now() + blocked.fail()
        pauseReason = errorText(e)
        setStatus({ state: 'paused', message: `${errorText(e)}. Pausing until ${ukTime(pausedUntil)}, then trying again gently.` })
        nextCheck = pausedUntil + jitter(MIN, 5 * MIN)
        continue
      }
      if (/stopped responding|didn’t answer|Target (page|closed)|has been closed/i.test(errorText(e))) {
        log('Restarting the browser…')
        await sb.restart().catch((err) => log(`Browser restart failed: ${errorText(err)}`))
      }
      const wait = trouble.fail()
      if (status.state !== 'needs_code') setStatus({ state: 'error', message: `${errorText(e)}. Trying again at ${ukTime(Date.now() + wait)}.` })
      nextCheck = Date.now() + wait
    }
  }

  async function ready() {
    await sb.ensureLoggedIn()
    if (status.state !== 'ready') setStatus({ state: 'ready', message: 'Connected to Sainsbury’s.' })
  }

  async function refreshFavourites() {
    const favourites = await sb.favourites()
    await cloud.products(favourites)
    saved.lastFavourites = Date.now()
    saveState(saved)
    nextFavourites = saved.lastFavourites + favouritesGap()
    setStatus({ favourites: favourites.slice(0, 12) })
    log(`Synced ${favourites.length} favourites`)
    return favourites.length
  }

  /** Order list, then the items of a few orders not yet stored (a little more each run). */
  async function syncOrders(maxDetails) {
    setStatus({ syncingOrders: true })
    try {
      const firstRun = !saved.lastOrders
      const { orders, source } = await sb.orderList()
      let all = orders
      if (source && orders.length) {
        const older = await sb.moreOrders(source, firstRun ? 6 : 2)
        all = [...orders, ...older.filter((o) => !orders.some((x) => x.uid === o.uid))]
      }
      const reply = all.length ? await cloud.orders(all, false) : { needItems: [] }
      // Only delivered orders: earlier ones can still change.
      const cutoff = Date.now() - 6 * HOUR
      const todo = (reply.needItems ?? []).filter((o) => !o.slotAt || new Date(o.slotAt).getTime() < cutoff).slice(0, maxDetails)
      let detailed = 0
      for (const o of todo) {
        await pause(3000, 9000)
        const items = await sb.orderItems(o.uid, source)
        if (!items) continue
        await cloud.orders([{ uid: o.uid, items }], false)
        detailed++
      }
      await cloud.orders([], true)
      saved.lastOrders = Date.now()
      saveState(saved)
      nextOrders = saved.lastOrders + ordersGap()
      log(`Synced ${all.length} orders (${detailed} with items)`)
      return { orders: all.length, detailed }
    } finally {
      setStatus({ syncingOrders: false })
    }
  }

  async function work(job) {
    if (!job) {
      await ready()
      const now = Date.now()
      if (isDaytime() && now >= nextFavourites) await refreshFavourites()
      else if (isDaytime() && now >= nextOrders) await syncOrders(6)
      else await refreshBasket(sb)
      nextCheck = Date.now() + keepAliveGap()
      return
    }
    await ready()
    let result = {}
    if (job.kind === 'refresh') {
      result = { favourites: await refreshFavourites() }
    } else if (job.kind === 'orders') {
      result = await syncOrders(12)
    } else if (job.kind === 'add') {
      await sb.add(String(job.payload.uid), clampQty(job.payload.quantity ?? 1, 1))
    } else if (job.kind === 'set') {
      await sb.setQuantity(String(job.payload.uid), clampQty(job.payload.quantity, 0))
    }
    const basket = await refreshBasket(sb)
    nextCheck = Date.now() + keepAliveGap()
    if (job.id) await cloud.report({ jobId: job.id, ok: true, result: { ...result, basket: { count: basket.count, total: basket.total } }, status: appStatus() })
  }
}

/** Reject if a job runs too long (longer allowance while waiting for a text code). */
function hangGuard(promise, limitMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const limit = status.state === 'needs_code' ? Math.max(CODE_TIMEOUT_MS, limitMs) : limitMs
      if (Date.now() - started > limit) {
        clearInterval(timer)
        reject(new Error('Sainsbury’s stopped responding'))
      }
    }, 5000)
    promise.then(
      (v) => {
        clearInterval(timer)
        resolve(v)
      },
      (e) => {
        clearInterval(timer)
        reject(e)
      },
    )
  })
}

async function refreshBasket(sb) {
  const basket = await sb.basket()
  setStatus({ basket: { count: basket.count, total: basket.total.toFixed(2), items: basket.items } })
  return basket
}

function clampQty(v, min) {
  return Math.max(min, Math.min(99, Math.floor(Number(v) || 0)))
}

function appStatus() {
  const state = ['starting', 'logging_in', 'needs_code', 'ready', 'error', 'paused'].includes(status.state) ? status.state : 'error'
  const b = status.basket
  return {
    state,
    message: status.message,
    ...(b ? { basket: { count: b.count, total: Number(b.total), items: (b.items ?? []).map((i) => ({ uid: i.uid, qty: i.qty })) } } : {}),
  }
}

async function pollLoop(cloud, enqueue) {
  for (;;) {
    try {
      const { jobs } = await cloud.poll()
      if (!status.connected) {
        setStatus({ connected: true })
        log('Connected to Famz.')
      }
      for (const job of jobs ?? []) {
        if (job.kind === 'code') {
          const accepted = submitCode(String(job.payload?.code ?? ''))
          await cloud.report({ jobId: job.id, ok: accepted, error: accepted ? undefined : 'Sainsbury’s isn’t waiting for a code right now.' })
        } else {
          enqueue(job)
        }
      }
    } catch (e) {
      setStatus({ connected: false })
      log(`Can’t reach Famz: ${errorText(e)}`)
      await sleep(15_000)
    }
  }
}

import fs from 'node:fs'
import { Cloud } from './cloud.mjs'
import { Sainsburys, setStore } from './sainsburys.mjs'
import { startServer } from './server.mjs'
import { log, onStatus, setStatus, status, submitCode } from './status.mjs'

const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))
startServer(8099)

const KEEPALIVE_MS = 10 * 60_000
const FAVOURITES_MS = 6 * 60 * 60_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const errorText = (e) => (e instanceof Error ? e.message : String(e))

if (!options.email || !options.password) {
  setStatus({ state: 'needs_config', message: 'Enter your Sainsbury’s email and password in the Configuration tab, then restart.' })
} else if (!options.connector_token) {
  setStatus({ state: 'needs_config', message: 'Paste the connector token from Redmond’s App (Settings → Sainsbury’s) into the Configuration tab, then restart.' })
} else {
  run().catch((e) => setStatus({ state: 'error', message: errorText(e) }))
}
setInterval(() => {}, 1 << 30)

async function run() {
  if (options.store_number) setStore(options.store_number)
  const cloud = new Cloud(options.connector_token)
  const sb = new Sainsburys(options.email, options.password)

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

  pollLoop(cloud, enqueue)

  await sb.start()
  enqueue({ id: null, kind: 'refresh' })
  let lastFavourites = 0
  let lastCheck = Date.now()

  for (;;) {
    if (!queue.length) {
      await new Promise((r) => {
        wake = r
        setTimeout(r, 60_000)
      })
      wake = null
    }
    const job = queue.shift()
    try {
      if (!job) {
        if (Date.now() - lastFavourites > FAVOURITES_MS) enqueue({ id: null, kind: 'refresh' })
        else if (Date.now() - lastCheck > KEEPALIVE_MS) {
          lastCheck = Date.now()
          await sb.ensureLoggedIn()
          await refreshBasket(sb)
        }
        continue
      }
      await sb.ensureLoggedIn()
      if (status.state !== 'ready') setStatus({ state: 'ready', message: 'Connected to Sainsbury’s.' })
      lastCheck = Date.now()
      let result = {}
      if (job.kind === 'refresh') {
        const favourites = await sb.favourites()
        await cloud.products(favourites)
        lastFavourites = Date.now()
        setStatus({ favourites: favourites.slice(0, 12) })
        log(`Synced ${favourites.length} favourites`)
        result = { favourites: favourites.length }
      } else if (job.kind === 'add') {
        await sb.add(String(job.payload.uid), clampQty(job.payload.quantity ?? 1, 1))
      } else if (job.kind === 'set') {
        await sb.setQuantity(String(job.payload.uid), clampQty(job.payload.quantity, 0))
      }
      const basket = await refreshBasket(sb)
      if (job.id) await cloud.report({ jobId: job.id, ok: true, result: { ...result, basket: { count: basket.count, total: basket.total } }, status: appStatus() })
    } catch (e) {
      log(`Job ${job?.kind ?? 'check'} failed: ${errorText(e)}`)
      if (job?.id) await cloud.report({ jobId: job.id, ok: false, error: errorText(e) })
      if (status.state !== 'needs_code') setStatus({ state: 'error', message: errorText(e) })
      await sleep(2000)
    }
  }
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
  const state = ['starting', 'logging_in', 'needs_code', 'ready', 'error'].includes(status.state) ? status.state : 'error'
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
        log('Connected to Redmond’s App.')
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
      log(`Can’t reach Redmond’s App: ${errorText(e)}`)
      await sleep(15_000)
    }
  }
}

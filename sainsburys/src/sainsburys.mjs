// Drives the Sainsbury's groceries website in a hidden Chromium, as the
// account holder. Unofficial: endpoints are the ones the website itself
// uses, and can change without notice.
import fs from 'node:fs'
import { chromium } from 'playwright-core'
import { findItems, findOrders, shape } from './orders.mjs'
import { BlockedError, LoginGuard, looksBlocked, pause, Throttle } from './pacing.mjs'
import { log, setStatus, waitForCode } from './status.mjs'

const SITE = 'https://www.sainsburys.co.uk'
const API = `${SITE}/groceries-api/gol-services`
const PROFILE_DIR = '/data/browser' // persistent: remembers this "device" and its cookies
let STORE = '0560'
export function setStore(n) {
  if (/^\d{3,5}$/.test(String(n ?? ''))) STORE = String(n)
}
const LAUNCH = {
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  // AutomationControlled off: no navigator.webdriver, like a normal Chrome.
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
}
// Pages the website uses to list past orders (tried in turn; the first that
// loads order data wins).
const ORDER_PAGES = ['/gol-ui/my-account/orders', '/gol-ui/my-orders', '/gol-ui/my-account']

export class Sainsburys {
  /** @type {import('playwright').BrowserContext | null} */
  context = null
  /** @type {import('playwright').Page | null} */
  page = null

  constructor(email, password) {
    this.email = email
    this.password = password
    // A random gap between requests, like someone clicking around.
    this.throttle = new Throttle(900, 2600)
    this.loginGuard = new LoginGuard('/data/login-attempts.json')
  }

  async start() {
    const probe = await chromium.launch(LAUNCH)
    const version = probe.version()
    await probe.close()
    this.identity = browserIdentity(version)
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      ...LAUNCH,
      headless: true,
      locale: 'en-GB',
      // What Chrome itself sends for an en-GB browser (Playwright would send just "en-GB").
      extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
      timezoneId: 'Europe/London',
      viewport: { width: 1366, height: 768 },
      screen: { width: 1366, height: 768 },
      colorScheme: 'light',
    })
    this.context.on('page', (p) => this.disguise(p).catch(() => {}))
    this.page = this.context.pages()[0] ?? (await this.context.newPage())
    await this.disguise(this.page)
  }

  /**
   * Same user agent in the header, in JavaScript and in the client hints
   * (sec-ch-ua), in the format a real Chrome sends, without "Headless".
   * A mismatch between these is one of the first things bot managers check.
   */
  async disguise(page) {
    const cdp = await this.context.newCDPSession(page)
    await cdp.send('Network.setUserAgentOverride', this.identity)
  }

  /** page.goto that rides out Chromium's transient network errors (common in containers). */
  async goto(url) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        await this.checkPage(res?.status() ?? 200)
        return res
      } catch (e) {
        if (e instanceof BlockedError) throw e
        const msg = String(e?.message ?? e)
        if (attempt >= 5 || !/net::ERR_(NETWORK_CHANGED|INTERNET_DISCONNECTED|CONNECTION_RESET|NAME_NOT_RESOLVED|TIMED_OUT)|Timeout/.test(msg)) throw e
        log(`Network hiccup (${msg.match(/net::\w+|Timeout/)?.[0]}), retrying ${attempt}/4…`)
        await this.page.waitForTimeout(3000 * attempt)
      }
    }
  }

  /** Throw BlockedError if the page we landed on is a bot challenge. */
  async checkPage(status) {
    const title = await this.page.title().catch(() => '')
    const text = status >= 400 || /captcha|interruption|human/i.test(title) ? await this.page.locator('body').innerText({ timeout: 3000 }).catch(() => '') : ''
    if (looksBlocked({ status, text, title })) {
      await this.screenshot()
      throw new BlockedError('Sainsbury’s showed an “are you human?” check')
    }
  }

  /** Move the mouse to a random spot on the element and click, like a person. */
  async humanClick(locator) {
    await locator.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {})
    const box = await locator.boundingBox({ timeout: 10_000 }).catch(() => null)
    if (!box) return locator.click({ timeout: 15_000 })
    const x = box.x + box.width * (0.3 + Math.random() * 0.4)
    const y = box.y + box.height * (0.3 + Math.random() * 0.4)
    await this.page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 10) })
    await pause(80, 260)
    await this.page.mouse.down()
    await pause(40, 120)
    await this.page.mouse.up()
  }

  /** Click into a box and type with uneven key timing. */
  async humanType(locator, text) {
    await this.humanClick(locator)
    await pause(150, 400)
    await locator.fill('')
    await locator.pressSequentially(text, { delay: 60 + Math.random() * 90 })
  }

  async screenshot() {
    await this.page?.screenshot({ path: '/data/last-screen.png', timeout: 10_000 }).catch(() => {})
  }

  /** Throw away the browser window and start again (after a hang). */
  async restart() {
    await this.screenshot()
    await this.stop()
    await this.start()
    this.okAt = 0
  }

  async stop() {
    await this.context?.close().catch(() => {})
  }

  async authToken() {
    const cookies = await this.context.cookies(SITE)
    return cookies.find((c) => c.name.startsWith('WC_AUTHENTICATION_'))?.value ?? null
  }

  /** Call the website's own API from inside the logged-in page. */
  async api(method, path, { params = {}, body } = {}) {
    const url = new URL(path.startsWith('https://') ? path : API + path)
    if (url.origin !== SITE) throw new Error('Refusing to call a non-Sainsbury’s address')
    await this.throttle.wait()
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
    const token = await this.authToken()
    if (!this.page.url().startsWith(SITE)) await this.goto(`${SITE}/gol-ui/groceries`)
    const call = this.page.evaluate(
      async ({ method, url, body, token }) => {
        const res = await fetch(url, {
          method,
          signal: AbortSignal.timeout(20_000),
          credentials: 'include',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { wcauthtoken: token } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        })
        const text = await res.text()
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          // not JSON
        }
        return { status: res.status, json, text: json ? '' : text.slice(0, 300) }
      },
      { method, url: url.toString(), body, token },
    )
    const r = await withTimeout(call, 30_000, `Sainsbury’s didn’t answer (${url.pathname})`)
    if (looksBlocked({ status: r.status, text: r.text })) throw new BlockedError(`Sainsbury’s asked us to slow down (HTTP ${r.status})`)
    if (r.status === 401 || r.status === 403) this.okAt = 0
    return r
  }

  basketParams() {
    return { pick_time: new Date(Date.now() + 86_400_000).toISOString(), store_number: STORE, slot_booked: 'false' }
  }

  async isLoggedIn() {
    if (!(await this.authToken())) return false
    const r = await this.api('GET', '/basket/v2/basket', { params: this.basketParams() })
    return r.status === 200
  }

  async dismissCookieBanner() {
    const accept = this.page.locator('#onetrust-accept-btn-handler')
    if (await accept.isVisible({ timeout: 4000 }).catch(() => false)) {
      await accept.click().catch(() => {})
      await this.page.waitForTimeout(1500)
    }
    await this.page.evaluate(() => {
      document.querySelector('.onetrust-pc-dark-filter')?.remove()
      document.querySelector('#onetrust-consent-sdk')?.remove()
    })
  }

  /** Log in, at most a few times in a few hours (see LoginGuard). */
  async login() {
    this.loginGuard.begin()
    try {
      await this.loginOnce()
      this.loginGuard.succeeded()
    } catch (e) {
      // A challenge isn't a failed login; the pause logic handles it.
      if (!(e instanceof BlockedError)) this.loginGuard.failed()
      throw e
    }
  }

  async loginOnce() {
    setStatus({ state: 'logging_in', message: 'Logging in to Sainsbury’s…' })
    const page = this.page
    // Arrive the way a person does: the groceries home page first.
    await this.goto(`${SITE}/gol-ui/groceries`)
    await pause(2500, 5000)
    await this.dismissCookieBanner()
    await this.goto(`${SITE}/gol-ui/oauth/login`)
    await pause(2500, 4500)
    log(`Login page: ${new URL(page.url()).host}${new URL(page.url()).pathname}`)
    if (!page.url().includes('login') && (await this.isLoggedIn().catch(() => false))) return
    await this.dismissCookieBanner()

    const emailBox = page.locator('input[type="email"], input[name="email"], #username').first()
    await emailBox.waitFor({ timeout: 20_000 })
    await this.humanType(emailBox, this.email)
    await pause(400, 1100)
    await this.humanType(page.locator('input[type="password"], input[name="password"], #password').first(), this.password)
    await pause(500, 1300)
    await this.dismissCookieBanner()
    await this.humanClick(page.locator('button[type="submit"], button[data-testid="log-in"]').first())
    await page.waitForTimeout(6000)
    await this.checkPage(200)
    log(`After login: ${new URL(page.url()).host}${new URL(page.url()).pathname}`)

    if (page.url().includes('/mfa') || (await page.locator('#code, input[name="code"]').count()) > 0) {
      setStatus({ state: 'needs_code', message: 'Sainsbury’s has sent a code by text. Open this add-on’s Web UI and type it in.' })
      const code = await waitForCode(10 * 60_000)
      setStatus({ state: 'logging_in', message: 'Checking the code…' })
      await this.dismissCookieBanner()
      await this.humanType(page.locator('#code, input[name="code"]').first(), code)
      await pause(400, 1000)
      await this.humanClick(page.locator('button[data-testid="submit-code"], button[type="submit"]').first())
      await page.waitForTimeout(6000)
      await this.checkPage(200)
    }

    if (!page.url().startsWith(SITE)) await this.goto(`${SITE}/gol-ui/groceries`)
    if (!(await this.isLoggedIn())) {
      await this.screenshot()
      const where = new URL(page.url()).pathname
      const title = await page.title().catch(() => '')
      throw new Error(`Login didn’t work (ended on ${where}${title ? `, “${title}”` : ''}). Check the email and password.`)
    }
  }

  /** Log in if needed. Trusts a recent successful check to keep taps fast. */
  async ensureLoggedIn() {
    if (this.okAt && Date.now() - this.okAt < 2 * 60_000) return
    let ok = false
    try {
      ok = await this.isLoggedIn()
    } catch (e) {
      if (e instanceof BlockedError) throw e
    }
    if (!ok) await this.login()
    this.okAt = Date.now()
  }

  async favourites(max = 120) {
    const out = []
    for (let page = 1; out.length < max && page <= 10; page++) {
      const r = await this.api('GET', '/product/v1/favourites', {
        params: { minimised: 'true', store_identifier: STORE, page_number: page, page_size: 24 },
      })
      if (r.status !== 200) throw new Error(`Favourites request failed (HTTP ${r.status}) ${r.text}`)
      const batch = (r.json?.products ?? []).map(mapProduct)
      out.push(...batch)
      if (batch.length < 24) break
    }
    return out.slice(0, max)
  }

  async basketRaw() {
    const r = await this.api('GET', '/basket/v2/basket', { params: this.basketParams() })
    if (r.status !== 200) throw new Error(`Trolley request failed (HTTP ${r.status}) ${r.text}`)
    return r.json ?? {}
  }

  /** Trolley summary: count, total and quantity per product. */
  async basket() {
    const data = await this.basketRaw()
    const items = (data.items ?? []).map((it) => ({
      uid: String(it.product?.product_uid ?? it.product?.sku ?? ''),
      itemUid: it.item_uid,
      qty: Number(it.quantity) || 0,
    }))
    return { count: data.item_count ?? items.reduce((n, i) => n + i.qty, 0), total: Number(data.total_price ?? 0), items }
  }

  /** Set a product's trolley quantity (0 removes it). */
  async setQuantity(productUid, quantity) {
    const { items } = await this.basket()
    const item = items.find((i) => i.uid === String(productUid))
    if (!item) {
      if (quantity > 0) await this.add(productUid, quantity)
      return
    }
    const r = await this.api('PUT', '/basket/v2/basket', {
      params: this.basketParams(),
      body: {
        items: [
          {
            product_uid: String(productUid),
            quantity,
            uom: 'ea',
            selected_catchweight: '',
            item_uid: item.itemUid,
            decreasing_quantity: quantity < item.qty,
          },
        ],
      },
    })
    if (r.status >= 300) throw new Error(`Changing the trolley failed (HTTP ${r.status}) ${r.text}`)
    log(`Set product ${productUid} to ×${quantity}`)
  }

  async add(productUid, quantity = 1) {
    const r = await this.api('POST', '/basket/v2/basket/item', {
      params: this.basketParams(),
      body: { product_uid: productUid, quantity, uom: 'ea', selected_catchweight: '' },
    })
    if (r.status >= 300) throw new Error(`Adding to trolley failed (HTTP ${r.status}) ${r.text}`)
    log(`Added product ${productUid} ×${quantity}`)
  }

  /**
   * Visit "My orders" like a person would, and read the order list out of
   * the JSON the page itself loads. Returns { orders, source } where source
   * is the API address that had them (used for order details).
   */
  async orderList() {
    const seen = []
    const onResponse = async (res) => {
      const url = res.url()
      if (!url.startsWith(`${SITE}/groceries-api/`) || !/order/i.test(url)) return
      if (!/json/.test(res.headers()['content-type'] ?? '')) return
      const json = await res.json().catch(() => null)
      if (json) seen.push({ url, json })
    }
    this.page.on('response', onResponse)
    let best = { orders: [], source: null }
    try {
      for (const path of ORDER_PAGES) {
        await this.goto(SITE + path)
        await pause(4000, 7000)
        await this.dismissCookieBanner()
        await this.page.mouse.wheel(0, 300 + Math.random() * 500).catch(() => {})
        await pause(1500, 3000)
        if (path === '/gol-ui/my-account' && !seen.length) {
          // Follow the account page's own link to orders, if there is one.
          const link = this.page.getByRole('link', { name: /orders/i }).first()
          if (await link.isVisible({ timeout: 3000 }).catch(() => false)) {
            await this.humanClick(link)
            await pause(4000, 7000)
          }
        }
        for (const s of seen) {
          const orders = findOrders(s.json)
          if (orders.length > best.orders.length) best = { orders, source: s.url }
        }
        if (best.orders.length) this.ordersPage = this.page.url()
        if (best.orders.length) break
      }
    } finally {
      this.page.off('response', onResponse)
    }
    if (!best.orders.length) {
      this.debugDump('orders-list', seen)
      log(`No orders found. Order API calls seen: ${seen.map((s) => new URL(s.url).pathname).join(', ') || 'none'}`)
      for (const s of seen.slice(0, 3)) log(`Shape of ${new URL(s.url).pathname}: ${JSON.stringify(shape(s.json)).slice(0, 800)}`)
    } else {
      log(`Found ${best.orders.length} orders via ${new URL(best.source).pathname}`)
    }
    return best
  }

  /** Older pages of the order list, when the list address is paged. */
  async moreOrders(source, maxPages = 6) {
    const url = new URL(source)
    const key = [...url.searchParams.keys()].find((k) => /page_?(number|num|no)?$|^page$/i.test(k) && !/size/i.test(k))
    if (!key) return []
    const out = []
    for (let n = Number(url.searchParams.get(key)) + 1; n <= maxPages; n++) {
      url.searchParams.set(key, String(n))
      await pause(2000, 5000)
      const r = await this.api('GET', url.toString())
      if (r.status !== 200) break
      const batch = findOrders(r.json)
      if (!batch.length || batch.every((o) => out.some((x) => x.uid === o.uid))) break
      out.push(...batch)
    }
    return out
  }

  /** Lines of one past order, or null if they couldn't be read. */
  async orderItems(uid, source) {
    // Most APIs put one order at <list address>/<order id>.
    if (source) {
      const base = new URL(source)
      const r = await this.api('GET', `${base.origin}${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(uid)}`)
      const items = r.status === 200 ? findItems(r.json) : []
      if (items.length) return items
    }
    // Otherwise open the order's page and read what it loads.
    const seen = []
    const onResponse = async (res) => {
      if (!res.url().startsWith(`${SITE}/groceries-api/`)) return
      if (!/json/.test(res.headers()['content-type'] ?? '')) return
      const json = await res.json().catch(() => null)
      if (json) seen.push({ url: res.url(), json })
    }
    this.page.on('response', onResponse)
    try {
      // Prefer clicking the order on the orders page; fall back to a guess at its address.
      let opened = false
      if (this.ordersPage) {
        if (this.page.url() !== this.ordersPage) {
          await this.goto(this.ordersPage)
          await pause(3000, 6000)
        }
        const link = this.page.locator(`a[href*="${uid}"]`).first()
        if (await link.isVisible({ timeout: 3000 }).catch(() => false)) {
          await this.humanClick(link)
          opened = true
        }
      }
      if (!opened) await this.goto(`${SITE}/gol-ui/my-account/orders/${encodeURIComponent(uid)}`)
      await pause(4000, 7000)
      await this.page.mouse.wheel(0, 400 + Math.random() * 600).catch(() => {})
      await pause(1000, 2500)
    } finally {
      this.page.off('response', onResponse)
    }
    let best = []
    for (const s of seen) {
      const items = findItems(s.json)
      if (items.length > best.length) best = items
    }
    if (!best.length) {
      this.debugDump(`order-${uid}`, seen)
      log(`Couldn’t read the items of order ${uid}. API calls seen: ${seen.map((s) => new URL(s.url).pathname).join(', ') || 'none'}`)
      return null
    }
    return best
  }

  /** Keep the last raw responses on this machine to help fix parsing. */
  debugDump(name, seen) {
    try {
      fs.mkdirSync('/data/debug', { recursive: true })
      fs.writeFileSync(`/data/debug/${name}.json`, JSON.stringify(seen.slice(0, 10), null, 1).slice(0, 2_000_000))
    } catch {
      // not fatal
    }
  }
}

/** User agent and client hints for this Chromium version, as real Chrome sends them. */
function browserIdentity(version) {
  const major = version.split('.')[0]
  return {
    // Chrome's reduced user agent: major version only, Linux always "x86_64".
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    acceptLanguage: 'en-GB,en',
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Not)A;Brand', version: '24' },
      ],
      fullVersionList: [
        { brand: 'Chromium', version },
        { brand: 'Not)A;Brand', version: '24.0.0.0' },
      ],
      fullVersion: version,
      platform: 'Linux',
      platformVersion: '',
      architecture: process.arch === 'arm64' ? 'arm' : 'x86',
      bitness: '64',
      model: '',
      mobile: false,
      wow64: false,
    },
  }
}

export function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

function mapProduct(p) {
  const unit = p.unit_price?.price != null && p.unit_price?.measure ? `£${Number(p.unit_price.price).toFixed(2)}/${p.unit_price.measure}` : null
  return {
    uid: String(p.product_uid),
    name: p.name,
    price: p.retail_price?.price ?? null,
    unitPrice: unit,
    image: p.image ?? p.assets?.plp_image ?? p.image_thumbnail ?? null,
  }
}

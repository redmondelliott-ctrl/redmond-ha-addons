// Drives the Sainsbury's groceries website in a hidden Chromium, as the
// account holder. Unofficial: endpoints are the ones the website itself
// uses, and can change without notice.
import { chromium } from 'playwright-core'
import { log, setStatus, waitForCode } from './status.mjs'

const SITE = 'https://www.sainsburys.co.uk'
const API = `${SITE}/groceries-api/gol-services`
const PROFILE_DIR = '/data/browser' // persistent: remembers this "device" and its cookies
const STORE = '0560'
const LAUNCH = { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] }

export class Sainsburys {
  /** @type {import('playwright').BrowserContext | null} */
  context = null
  /** @type {import('playwright').Page | null} */
  page = null

  constructor(email, password) {
    this.email = email
    this.password = password
  }

  async start() {
    // Use the real Chrome version in the user agent, minus "Headless".
    const probe = await chromium.launch(LAUNCH)
    const version = probe.version()
    await probe.close()
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      ...LAUNCH,
      headless: true,
      userAgent: `Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      viewport: { width: 1280, height: 900 },
    })
    this.page = this.context.pages()[0] ?? (await this.context.newPage())
  }

  /** page.goto that rides out Chromium's transient network errors (common in containers). */
  async goto(url) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      } catch (e) {
        const msg = String(e?.message ?? e)
        if (attempt >= 5 || !/net::ERR_(NETWORK_CHANGED|INTERNET_DISCONNECTED|CONNECTION_RESET|NAME_NOT_RESOLVED|TIMED_OUT)|Timeout/.test(msg)) throw e
        log(`Network hiccup (${msg.match(/net::\w+|Timeout/)?.[0]}), retrying ${attempt}/4…`)
        await this.page.waitForTimeout(3000 * attempt)
      }
    }
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
    const url = new URL(API + path)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
    const token = await this.authToken()
    if (!this.page.url().startsWith(SITE)) await this.goto(`${SITE}/gol-ui/groceries`)
    return this.page.evaluate(
      async ({ method, url, body, token }) => {
        const res = await fetch(url, {
          method,
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

  async login() {
    setStatus({ state: 'logging_in', message: 'Logging in to Sainsbury’s…' })
    const page = this.page
    await this.goto(`${SITE}/gol-ui/oauth/login`)
    await page.waitForTimeout(3000)
    if (await this.isLoggedIn()) return
    await this.dismissCookieBanner()

    const emailBox = page.locator('input[type="email"], input[name="email"], #username').first()
    await emailBox.waitFor({ timeout: 20_000 })
    await emailBox.fill(this.email)
    await page.waitForTimeout(400)
    await page.locator('input[type="password"], input[name="password"], #password').first().fill(this.password)
    await page.waitForTimeout(400)
    await this.dismissCookieBanner()
    await page.locator('button[type="submit"], button[data-testid="log-in"]').first().click()
    await page.waitForTimeout(6000)

    if (page.url().includes('/mfa') || (await page.locator('#code, input[name="code"]').count()) > 0) {
      setStatus({ state: 'needs_code', message: 'Sainsbury’s has sent a code by text. Open this add-on’s Web UI and type it in.' })
      const code = await waitForCode(10 * 60_000)
      setStatus({ state: 'logging_in', message: 'Checking the code…' })
      await this.dismissCookieBanner()
      await page.locator('#code, input[name="code"]').first().fill(code)
      await page.waitForTimeout(400)
      await page.locator('button[data-testid="submit-code"], button[type="submit"]').first().click()
      await page.waitForTimeout(6000)
    }

    if (!(await this.isLoggedIn())) {
      const where = new URL(page.url()).pathname
      const title = await page.title().catch(() => '')
      throw new Error(`Login didn’t work (ended on ${where}${title ? `, “${title}”` : ''}). Check the email and password.`)
    }
  }

  async ensureLoggedIn() {
    if (await this.isLoggedIn().catch(() => false)) return
    await this.login()
  }

  async favourites(limit = 24) {
    const r = await this.api('GET', '/product/v1/favourites', {
      params: { minimised: 'true', store_identifier: STORE, page_number: 1, page_size: limit },
    })
    if (r.status !== 200) throw new Error(`Favourites request failed (HTTP ${r.status}) ${r.text}`)
    return (r.json?.products ?? []).map((p) => ({
      uid: p.product_uid,
      name: p.name,
      price: p.retail_price?.price ?? null,
      image: p.image ?? p.assets?.plp_image ?? null,
    }))
  }

  async basket() {
    const r = await this.api('GET', '/basket/v2/basket', { params: this.basketParams() })
    if (r.status !== 200) throw new Error(`Trolley request failed (HTTP ${r.status}) ${r.text}`)
    return { count: r.json?.item_count ?? 0, total: r.json?.total_price ?? '0.00' }
  }

  async add(productUid, quantity = 1) {
    const r = await this.api('POST', '/basket/v2/basket/item', {
      params: this.basketParams(),
      body: { product_uid: productUid, quantity, uom: 'ea', selected_catchweight: '' },
    })
    if (r.status >= 300) throw new Error(`Adding to trolley failed (HTTP ${r.status}) ${r.text}`)
    log(`Added product ${productUid} ×${quantity}`)
  }
}

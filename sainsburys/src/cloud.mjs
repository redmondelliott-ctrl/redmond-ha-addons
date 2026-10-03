// Talks to Famz (the `grocery` Edge Function). Only the connector
// token is sent; the Sainsbury's login never leaves this machine.
import { log } from './status.mjs'

const FUNCTION_URL = 'https://xlovbivuzrduggpayohx.supabase.co/functions/v1/grocery'

export class Cloud {
  constructor(token) {
    this.token = token
  }

  async call(action, body = {}, timeoutMs = 60_000) {
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': this.token },
      body: JSON.stringify({ action, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || `App server error (HTTP ${res.status})`)
    return json
  }

  poll() {
    return this.call('poll', {}, 70_000)
  }

  report(body) {
    return this.call('report', body).catch((e) => log(`Couldn’t report to the app: ${e.message}`))
  }

  products(products) {
    return this.call('products', { products })
  }
}

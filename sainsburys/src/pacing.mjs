// Keeping the connector's traffic small, spread out and person-shaped, and
// backing off at once when Sainsbury's pushes back. Sainsbury's sits behind
// a bot manager that scores traffic volume, timing regularity, login
// patterns and browser fingerprint; the cheapest way to stay in good
// standing is to look like one household using the website occasionally.
import fs from 'node:fs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A random number between min and max. */
export function jitter(min, max) {
  return min + Math.random() * (max - min)
}

/** Wait a random, human-ish amount of time. */
export function pause(minMs, maxMs) {
  return sleep(jitter(minMs, maxMs))
}

/** Hour of the day in the UK (0–23). */
export function ukHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(date))
}

/** 07:00–22:59 UK time: when a family might plausibly be on the website. */
export function isDaytime(date = new Date()) {
  const h = ukHour(date)
  return h >= 7 && h < 23
}

/** "14:05" in UK time. */
export function ukTime(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))
}

/** Sainsbury's (or its bot manager) wants us to stop for a while. */
export class BlockedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BlockedError'
  }
}

/** We've refused to try logging in again yet (to protect the account). */
export class LoginCooldownError extends Error {
  constructor(message, until) {
    super(message)
    this.name = 'LoginCooldownError'
    this.until = until
  }
}

const BLOCK_TEXT =
  /access denied|pardon our interruption|are you a (human|robot)|verify (that )?you are (a )?human|captcha|unusual (traffic|activity)|request unsuccessful|too many requests|bot manager|errors\.edgesuite\.net|reference\s*#\s*[\d.a-f]+/i

/**
 * Does this response look like a bot challenge or rate limit rather than a
 * normal answer? (A bare 401/403 from the API usually just means "logged out".)
 */
export function looksBlocked({ status, text = '', title = '' }) {
  if (status === 429) return true
  const blob = `${title}\n${String(text).slice(0, 3000)}`
  if ((status === 403 || status === 503) && BLOCK_TEXT.test(blob)) return true
  return status >= 200 && status < 300 && /captcha|pardon our interruption|verify you are human/i.test(title)
}

/** Keeps a random gap between consecutive requests to Sainsbury's. */
export class Throttle {
  constructor(minGapMs, maxGapMs) {
    this.min = minGapMs
    this.max = maxGapMs
    this.next = 0
  }

  async wait() {
    const now = Date.now()
    if (this.next > now) await sleep(this.next - now)
    this.next = Date.now() + jitter(this.min, this.max)
  }
}

/** Growing waits after repeated trouble: steps[0], steps[1], … (last one repeats). */
export class Backoff {
  constructor(steps) {
    this.steps = steps
    this.failures = 0
  }

  /** Record a failure; returns how long to wait (with ±15% jitter). */
  fail() {
    const base = this.steps[Math.min(this.failures, this.steps.length - 1)]
    this.failures++
    return Math.round(base * jitter(0.85, 1.15))
  }

  reset() {
    this.failures = 0
  }
}

/**
 * Remembers login attempts across restarts so a crash loop can't hammer the
 * login page (that is what gets accounts locked and IPs flagged).
 * At most `max` attempts per `windowMs`, and a growing wait after failures.
 */
export class LoginGuard {
  constructor(file, { max = 4, windowMs = 6 * 3600_000, failWaits = [5 * 60_000, 30 * 60_000, 2 * 3600_000] } = {}) {
    this.file = file
    this.max = max
    this.windowMs = windowMs
    this.failWaits = failWaits
    this.state = { attempts: [], failures: 0, lastFailure: 0 }
    try {
      Object.assign(this.state, JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch {
      // first run
    }
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state))
    } catch {
      // /data missing outside Home Assistant; fine
    }
  }

  /** When the next attempt is allowed (ms epoch); 0 if now. */
  nextAllowed(now = Date.now()) {
    const recent = this.state.attempts.filter((t) => now - t < this.windowMs)
    let at = 0
    if (recent.length >= this.max) at = Math.min(...recent) + this.windowMs
    if (this.state.failures > 0) {
      const wait = this.failWaits[Math.min(this.state.failures - 1, this.failWaits.length - 1)]
      at = Math.max(at, this.state.lastFailure + wait)
    }
    return at > now ? at : 0
  }

  /** Throws LoginCooldownError if we should not try yet; otherwise records the attempt. */
  begin(now = Date.now()) {
    const at = this.nextAllowed(now)
    if (at) throw new LoginCooldownError(`Waiting until ${ukTime(at)} before logging in again, to protect your account`, at)
    this.state.attempts = [...this.state.attempts.filter((t) => now - t < this.windowMs), now]
    this.save()
  }

  succeeded() {
    this.state.failures = 0
    this.save()
  }

  failed(now = Date.now()) {
    this.state.failures++
    this.state.lastFailure = now
    this.save()
  }
}

// Shared status shown on the Web UI and in the add-on log. Never put the
// password, cookies or tokens in here.

export const status = {
  state: 'starting', // starting | logging_in | needs_code | ready | error | needs_config
  message: 'Starting…',
  favourites: [],
  connected: false,
  basket: null,
  lastTest: null,
  updatedAt: new Date().toISOString(),
}

const listeners = new Set()
export function onStatus(fn) {
  listeners.add(fn)
}

export function setStatus(patch) {
  Object.assign(status, patch, { updatedAt: new Date().toISOString() })
  if (patch.message) log(patch.message)
  if (patch.state || patch.message || patch.basket) for (const fn of listeners) fn(status)
}

export function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

// One pending text-message code request at a time.
let codeWaiter = null

export function waitForCode(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      codeWaiter = null
      reject(new Error('No code entered in time.'))
    }, timeoutMs)
    codeWaiter = (code) => {
      clearTimeout(timer)
      codeWaiter = null
      resolve(code)
    }
  })
}

export function submitCode(code) {
  if (!codeWaiter) return false
  codeWaiter(code)
  return true
}

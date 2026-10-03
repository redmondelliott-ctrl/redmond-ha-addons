// Tiny status page served through Home Assistant Ingress ("Open Web UI").
import fs from 'node:fs'
import http from 'node:http'
import { status, submitCode } from './status.mjs'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function page() {
  const fav = status.favourites
    .map((p) => `<li>${esc(p.name)}${p.price ? ` <span class="muted">£${esc(p.price)}</span>` : ''}</li>`)
    .join('')
  const codeForm =
    status.state === 'needs_code'
      ? `<form method="post" action="code" class="card">
           <label>Code from Sainsbury’s text message<br>
             <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}" required autofocus>
           </label>
           <button>Send code</button>
         </form>`
      : ''
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sainsbury's Connector</title>
<style>
  body{font:16px -apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#f2f2f7;color:#000}
  @media (prefers-color-scheme:dark){body{background:#000;color:#fff}.card{background:#1c1c1e!important}}
  .card{background:#fff;border-radius:14px;padding:16px;margin:0 0 16px}
  .muted{color:#8e8e93} h1{font-size:24px;margin:8px 0 16px}
  input{font-size:20px;padding:8px;width:10ch;margin:8px 0;border-radius:8px;border:1px solid #8e8e93}
  button{font-size:17px;padding:10px 18px;border:0;border-radius:10px;background:#0a60d0;color:#fff}
</style></head><body>
<h1>Sainsbury’s Connector</h1>
<div class="card"><b>${esc(status.state.replace('_', ' '))}</b><br>${esc(status.message)}
<div class="muted">${status.connected ? 'Connected to Famz' : 'Not connected to Famz yet'} · updated ${esc(status.updatedAt)}</div></div>
${codeForm}
${status.state === 'error' ? '<div class="card"><a href="screen.png">What the hidden browser last saw</a></div>' : ''}
${status.lastTest ? `<div class="card"><b>Test</b><br>${esc(status.lastTest)}</div>` : ''}
${status.basket ? `<div class="card"><b>Trolley</b><br>${esc(status.basket.count)} items · £${esc(status.basket.total)}</div>` : ''}
${fav ? `<div class="card"><b>Favourites (first ${status.favourites.length})</b><ul>${fav}</ul></div>` : ''}
<script>setTimeout(()=>location.reload(),${status.state === 'needs_code' ? 60000 : 5000})</script>
</body></html>`
}

export function startServer(port = 8099) {
  http
    .createServer((req, res) => {
      if (req.method === 'POST' && req.url?.endsWith('/code')) {
        let body = ''
        req.on('data', (c) => (body += c).length > 1000 && req.destroy())
        req.on('end', () => {
          const code = new URLSearchParams(body).get('code')?.trim() ?? ''
          if (/^\d{4,8}$/.test(code)) submitCode(code)
          res.writeHead(303, { Location: './' }).end()
        })
        return
      }
      if (req.url?.endsWith('/screen.png')) {
        fs.readFile('/data/last-screen.png', (err, buf) => {
          if (err) res.writeHead(404).end('No screenshot yet')
          else res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(buf)
        })
        return
      }
      if (req.url?.endsWith('/status.json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(status))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page())
    })
    .listen(port)
}

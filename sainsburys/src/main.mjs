import fs from 'node:fs'
import { Sainsburys } from './sainsburys.mjs'
import { startServer } from './server.mjs'
import { log, setStatus } from './status.mjs'

const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))
startServer(8099)

async function main() {
  if (!options.email || !options.password) {
    setStatus({ state: 'needs_config', message: 'Enter your Sainsbury’s email and password in the Configuration tab, then restart.' })
    return
  }
  const sb = new Sainsburys(options.email, options.password)
  await sb.start()
  try {
    await sb.ensureLoggedIn()
    setStatus({ state: 'ready', message: 'Logged in to Sainsbury’s.' })

    const favourites = await sb.favourites(12)
    setStatus({ favourites })
    log(`Found ${favourites.length} favourites`)

    let basket = await sb.basket()
    setStatus({ basket })
    log(`Trolley has ${basket.count} items (£${basket.total})`)

    // Only once per install, so restarts don't keep adding.
    const marker = '/data/test-added'
    if (options.test_add_first_favourite && favourites[0] && !fs.existsSync(marker)) {
      await sb.add(favourites[0].uid, 1)
      basket = await sb.basket()
      fs.writeFileSync(marker, new Date().toISOString())
      setStatus({ basket, lastTest: `Added 1 × ${favourites[0].name}. Trolley now has ${basket.count} items.` })
    }
    setStatus({ message: 'Test finished. Everything worked.' })
  } catch (e) {
    setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) })
    try {
      await sb.page?.screenshot({ path: '/data/last-error.png' })
    } catch {
      // ignore
    }
  } finally {
    await sb.stop()
  }
}

main().catch((e) => setStatus({ state: 'error', message: String(e?.message ?? e) }))
// Keep the Web UI up after the test.
setInterval(() => {}, 1 << 30)

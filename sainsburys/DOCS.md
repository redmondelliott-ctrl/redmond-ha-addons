# Sainsbury's Connector

Keeps a Sainsbury's groceries session on this Home Assistant machine so
Famz can add your favourites to your trolley.

**Unofficial.** Sainsbury's has no public API, so this drives their website
in a hidden browser, as you. It can stop working whenever they change their
site, and automated access may be against their terms.

## Setup

1. In Famz, go to **Settings → Sainsbury's** and tap
   **Create connector token**. Copy it.
2. Open this add-on's **Configuration** tab and fill in your Sainsbury's
   email and password, and paste the token into `connector_token`. Save.
   (`store_number` is optional; leave it blank.)
3. Start the add-on. Your favourites appear in the app's Shop tab.
4. If Sainsbury's texts you a code, the app asks for it (or type it into this
   add-on's **Open Web UI** page).

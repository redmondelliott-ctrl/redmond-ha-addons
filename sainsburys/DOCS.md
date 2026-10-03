# Sainsbury's Connector

Keeps a Sainsbury's groceries session on this Home Assistant machine so
Famz can add your favourites to your trolley and show what you've spent.

**Unofficial.** Sainsbury's has no public API, so this drives their website
in a hidden browser, as you. It can stop working whenever they change their
site, and automated access may be against their terms.

## Setup

1. In Famz, go to **Settings → Sainsbury's** and tap
   **Create connector token**. Copy it.
2. Open this add-on's **Configuration** tab and fill in your Sainsbury's
   email and password, and paste the token into `connector_token`. Save.
   (`store_number` is optional; leave it blank.)
3. Start the add-on. Your favourites appear in the app's Shop tab, and your
   past orders under **Shop → Spending** (filled in a few orders at a time).
4. If Sainsbury's texts you a code, the app asks for it (or type it into this
   add-on's **Open Web UI** page).

## Staying in Sainsbury's good books

Sainsbury's uses bot protection. To keep your account and home internet
connection in good standing, the connector:

- uses one browser profile that remembers this "device", so it rarely has
  to log in;
- logs in at most 4 times in 6 hours, waiting longer after each failure, so
  a wrong password can't lock your account;
- types and clicks at a human pace, and leaves random gaps between requests;
- checks in only now and then (every 12–25 minutes in the day, every hour
  or two overnight), syncs favourites a few times a day and orders once a
  day;
- stops at once if Sainsbury's shows an "are you human?" check or says
  "too many requests", pauses for 45 minutes to 8 hours, and shows
  **Paused** in the app. It never tries to solve those checks.

If it stays paused, log in to sainsburys.co.uk yourself in a normal browser
once, then restart the add-on.

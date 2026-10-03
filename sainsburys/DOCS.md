# Sainsbury's Connector

Keeps a Sainsbury's groceries session on this Home Assistant machine so
Redmond's App can add your favourites to your trolley.

**Unofficial.** Sainsbury's has no public API, so this drives their website
in a hidden browser, as you. It can stop working whenever they change their
site, and automated access may be against their terms.

## Setup

1. Open the **Configuration** tab, enter your Sainsbury's email and password,
   and save. They stay on this machine.
2. Start the add-on, then open **Open Web UI** to see its status.
3. If Sainsbury's texts you a code, type it into the Web UI.

## Version 0.1 (test)

Logs in, lists your first favourites, and (if `test_add_first_favourite` is
on) adds one of the first favourite to your trolley to prove it works.

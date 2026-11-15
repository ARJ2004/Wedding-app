# Device lab (OPS-04a)

Every guest-facing story is checked on these phones before it is "done" (sprint plan DoD). **Status: needs purchase** — the devices below are a shopping list for the product owner; until they arrive, checks run on the React Native Web preview (`pnpm --filter @mehfil/mobile preview:shots`) plus any phones the team owns.

## Matrix

| # | Device (or equivalent) | Why | OS | Budget (₹) |
| --- | --- | --- | --- | --- |
| 1 | Redmi A3 / Samsung Galaxy A05 (2–3 GB RAM) | The aunt-in-Hubli phone: slowest realistic guest device | Android 13/14 Go | 7–9k |
| 2 | Any Android 9 phone, 2 GB RAM (second-hand) | Oldest supported OS | Android 9 | 4–6k |
| 3 | Mid-range Android (Samsung A15 / Redmi Note) | Most common host/planner phone | Android 14 | 13–16k |
| 4 | iPhone SE (2nd/3rd gen) or iPhone 11 | Oldest supported iOS, small screen | iOS 15–17 | 15–25k (used) |

Plus a 10" Android tablet when PLN-01b (planner two-pane) and desk check-in on tablets start.

## Checklist per release (15 minutes)

- [ ] Cold start to Home under 3 s on device 1 (stopwatch until content shows) — budget from 25-app §9.
- [ ] Host: sign in, open wedding, Events, Guests search, import the sample sheet (`docs/samples/guest-list-sample.xlsx`).
- [ ] Guest (from S4): open an invite link, OTP, schedule, RSVP for the family, travel status.
- [ ] Large text (OS font size max + app Large text): nothing clipped or overlapping; Hindi/Kannada once enabled.
- [ ] Dark mode and high contrast readable.
- [ ] Airplane mode: cached screens still open; actions queue and sync (from APP-04).
- [ ] Rotate / split screen does not crash (tablet).
- [ ] Note app version, device, issues in the release ticket.

## Release health

Sentry React Native release health (crash-free sessions, app start) is wired with APP-08 once a Sentry DSN exists (**needs credentials: Sentry project**).

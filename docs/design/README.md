# Mehfil: design decisions (DSN)

Screen designs for the React Native app (Host mode and Guest mode). They are built only from the semantic tokens in `packages/design-tokens/src/palettes.ts`. The single theme switch is `packages/design-tokens/src/theme.config.ts`.

## Artifacts (Claude Design canvases, private)

| Canvas | Link | What it holds |
| --- | --- | --- |
| Mehfil App Screens | https://claude.ai/artifact/8NphvsDeW6Xawo3VzDMX1k | 13 phone screens (390×844) in Maroon & Marigold, light. Host row and Guest row; artboards link to each other in Play mode. |
| Mehfil Palette Chooser | https://claude.ai/artifact/97ScEnahwB3oijSU3az7c8 | Guest Home and Host Home in each of the 4 palettes, light and dark, labelled with the palette name, key, description and token swatches. A "Choose this palette" button marks a pick and shows the `THEME_CONFIG.palette` value to set. |

The links are private by default. Share them from the canvas's Share menu before sending them to anyone.

## Screen list

### Host mode (Google SSO)

| # | Screen | Arch ref | Key content |
| --- | --- | --- | --- |
| H1 | Welcome | APP §6 | Two large choices: **I have an invitation** (Paste link + Open invitation) and **I'm hosting a wedding**. |
| H2 | Host sign-in | APP §6, 00 Identity | "Continue with Google". Apple on iOS is pending APP-07. There is a note for team invites. |
| H3 | Host sign-in, dev build | APP §6/§8 | DEV BUILD badge (warning token), email field, seeded-user chips (`owner@`, `cohost@`, `planner@`, `desk@`), API base URL segmented control (Emulator / LAN IP / Staging). |
| H4 | Wedding picker | SET `WeddingsHome` | Wedding cards with a role badge (Owner, Planner, Desk staff), dates, city, countdown, and "Create a wedding". |
| H5 | Host Home | SET `WeddingOverview`, RSV | Couple and city, Switch wedding, countdown pill (accent), **Headcount** card (`HeadcountBar` + legend + "Remind 91 who haven't replied"), **Next event** card (primary), 2×2 quick actions, 5-tab bar. |
| H6 | Events + presets | SET `EventsList` | "Add from presets" chips (added = success outline with a check; not added = accent fill), event rows with an audience tag (All guests / Family + VIP / Groom side) and 48dp up/down reorder buttons. Drag and swipe are only shortcuts. |
| H7 | Guest list | GST `GuestList` | Count header, Add, search field, Filter, group chips (All, Bride side, Groom side, Family, Friends, VIP), Parties/People toggle, party rows (member count, groups, RSVP progress, phone warning with icon + text). |
| H8 | Party detail | GST `PartyEditor` (read view) | Group/outstation/language tags, members (primary contact, call button, dietary and access notes, phone-problem warning), RSVP by event, arrival leg, Record RSVP, Resend link (WhatsApp). |

Host tabs: **Home · Guests · Arrivals · Messages · More**. Desk staff get Arrivals · Check-in · More (ROL).

### Guest mode (link + OTP)

| # | Screen | Arch ref | Key content |
| --- | --- | --- | --- |
| G1 | Guest entry (OTP) | APP §6, ACC | "You're invited" header, **6 separate 64px-tall boxes** at 30px, masked phone, resend countdown, Continue, "Send to a different number", help contact. |
| G2 | Guest Home | GH §6 | "Namaste, Sunita", Family switch, **Next** hero card (written-out date, time, venue, dress code, Open in Maps), accent action card "Reply for the Reception", the next schedule card (time, venue, dress code, party RSVP state, Map button), 4-tab bar. |
| G3 | RSVP sheet | RSV, GH | Bottom sheet over a scrim (text token at 55%). Per family member: three 68px icon-over-label choices: **Attending** (success), **Not coming** (danger), **Maybe** (warning). Selected = filled. Then "Add a guest (1 more allowed)", Save replies, and an offline note. |
| G4 | Travel status | GH-03, ARR | Arrival summary (flight, pickup). Three 72dp buttons: **I've landed** (shown sent, success fill + time), **At the hotel**, **Running late** (opens 30 min / 1 h / 2 h / 3 h+). Help contact with Call and WhatsApp. |
| G5 | Guest Home, large text | GH-05 | Text ×1.3 (base 23px), dates fully written out, one card per row, 64dp buttons, 88dp tab bar with 17px labels. The rest of the content scrolls. |

Guest tabs: **Home · Schedule · Inbox · Family** (GH §6, at most four). See open question 1.

## Component inventory

This maps to the planned catalogue in `.claude/skills/run-team/lead.md`. Every component below appears in at least one artboard.

| Layer | Component | Variants shown | Screens |
| --- | --- | --- | --- |
| ui | `Screen` | background token, 16px gutters | all |
| ui | `TopBar` | back + title, back + title + action | H6, H8, G4 |
| ui | `Button` | primary (fill), secondary (primary outline), neutral (border outline), dashed add | all |
| ui | `IconButton` | 48×48 with `aria-label` (host only); guests always get icon + label | H6, H8 |
| ui | `TextField` / `SearchField` | default, focused (2px `focus` border), with leading icon | H1, H3, H7 |
| ui | `OtpInput` | 6 boxes: filled, focused (3px `focus`), empty | G1 |
| ui | `Chip` / `ChipGroup` | single-select filter, preset (added / addable), seeded user | H3, H6, H7 |
| ui | `Tag` | role badge, audience, outstation (info), warning, success, "Chosen" | H4, H6, H8 |
| ui | `Card` | surface, primary hero, accent action | H5, G2 |
| ui | `ListRow` | label/value, label + chevron | H8 |
| ui | `SegmentedControl` | 2 and 3 segments | H3, H7 |
| ui | `BottomSheet` | with scrim, handle and Close | G3 |
| ui | `TabBar` | host 5 tabs (72dp, 12px labels), guest 4 tabs (76dp, 14px), large text (88dp, 17px) | H5, H7, G2, G5 |
| components | `EventCard` | hero (next), compact schedule, host row with reorder | G2, H5, H6 |
| components | `HeadcountBar` | 4 segments + legend with icon + count + label | H5 |
| components | `PartyRow` | count avatar, groups, RSVP progress, phone warning | H7 |
| components | `RsvpChips` | per member, 3 choices, icon over label | G3 |
| components | `StatusChip` / status button | landed (sent), at hotel, running late | G4 |
| components | `TravelLegCard` | arrival summary | G4, H8 |
| components | `ContactRow` (new) | name, role, Call + WhatsApp | G4, G1 |
| components | `WeddingCard` (new) | role badge, dates, countdown | H4 |
| components | `ActionCard` (new) | accent "do this next" with chevron | G2 |

Three components are new and not in the lead.md catalogue: `ContactRow`, `WeddingCard` and `ActionCard`. Add them to `components/` when the first screen that needs one is built.

## Colour usage (semantic tokens only)

| Token | Used for |
| --- | --- |
| `background` | screen background, chooser section background |
| `surface` / `surfaceRaised` | cards, tab bar, inputs, sheets |
| `border` | card and input borders, waiting segment in `HeadcountBar`, unselected chips |
| `text` / `textMuted` | body / secondary text, inactive tabs. The scrim is `text` at 55% opacity. |
| `primary` / `onPrimary` | primary buttons, next-event hero, active tab, selected chips, headings in the chooser |
| `accent` / `onAccent` | countdown pill, "do this next" action card, addable preset chips. Accent is used only as a **fill** with `onAccent` text, never as text on surface (it is below 4.5:1 in some palettes). |
| `success` / `warning` / `danger` | RSVP Attending / Maybe / Not attending (fills and icons), "I've landed" sent, phone warnings, DEV BUILD badge |
| `info` / `focus` | outstation tag, team-invite note, focus ring on inputs and OTP boxes |

Status is never shown by colour alone. Every status has an icon (check / question mark / cross / clock / warning triangle) and a text label.

## Spacing, shape and touch targets

- **Grid:** 4px base. Common steps are 4, 8, 12, 16, 20, 24 and 32.
- **Screen gutters:** 16px (20px on auth screens). Vertical rhythm between cards is 12–16px.
- **Radius** (`radiusScale: 1`): 12px for buttons and inputs, 14–16px for cards, 18–20px for hero cards, 22px for the sheet top, 999px for chips and tags.
- **Touch targets:** at least **48dp** everywhere. Guest primary actions are 56–60dp. Travel status buttons are 72dp. RSVP choices are 68dp. Large-text mode uses 64dp.
- **Icons:** 24px stroke icons (2px), from an SVG subset as APP §9 requires (no icon fonts). Guest controls always show **icon + visible label**. Host icon-only buttons carry an `aria-label`.
- No gesture-only actions. Reordering has buttons, and swipe-to-delete has Undo.

## Typography

`fontFamily: System` (Roboto on Android, SF on iOS), as set in `theme.config.ts`. There is no web font, which keeps APK size and cold start down.

| Role | Host | Guest | Guest large text (×1.3) |
| --- | --- | --- | --- |
| Screen title | 22–26 / 700 | 26 / 700 | 34 / 700 |
| Hero title | 22 / 700 | 28 / 700 | 36 / 700 |
| Card title | 17–20 / 700 | 20 / 700 | 23 / 700 |
| Body | 15–16 / 400 | 17–18 / 400 | 23 / 400 |
| Secondary | 13–14 | 15–16 | 18–21 |
| Overline (CAPS, +0.6–0.8 letter-spacing) | 13 / 700 | 14–15 / 700 | 18 / 700 |
| Tab label | 12 | 14 | 17 |

- Guest base text is **18px**, matching the lite web. Line height is about 1.4–1.5×.
- Guest dates are written out: "Friday, 12 February, 10:00 am". Host lists use the short form "Fri 12 Feb · 10:00 am IST".
- The 1.3 large-text multiplier is applied on top of the OS scale and capped at 2.0 (GH-05). Large text makes layouts stack to one column.

## Content conventions

- Sample data: Ananya & Rohan, Udaipur, 12–14 Feb 2027 (Fri–Sun), all times IST. Events: Haldi (Fri 10:00 am), Mehendi (Fri 3:30 pm), Sangeet (Fri 8:00 pm), Baraat (Sat 6:30 pm), Pheras (Sat 9:00 pm), Reception (Sun 7:30 pm). Venue names are fictional.
- Guest persona: Sunita Sharma (Sharma family: Sunita, Kamla "Dadi", Arjun). All names and numbers are made up.
- Copy for guests uses plain words ("Not coming", "Save replies", "Where are you now?"). Hosts can see domain terms (RSVP, parties, groups).

## Palette choice

The current default is `maroonMarigold`. Use the Palette Chooser canvas to compare all four (maroonMarigold, mehendiGold, royalIndigoRose, peacockSaffron) in light and dark, then set `THEME_CONFIG.palette`. Planner branding (PLN-04) can override the palette per wedding.

## Open questions for the product owner

1. **Guest tabs.** APP §6 lists *Home · Travel · Camera · Photos · Me* (5 tabs). GH §6 lists *Home · Schedule · Inbox · Family* (at most 4). The designs follow GH (4 tabs, so labels stay large). Which one is final, and where do Camera and Photos go: Home tiles or a fifth tab?
2. **Palette.** Which palette ships as the default? Should dark mode follow the OS setting, or be off for guests at MVP?
3. **Apple sign-in** (APP-07) is still pending, so the host sign-in shows a placeholder line for it.

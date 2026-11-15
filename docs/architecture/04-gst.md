# E04 — Guest list and import (GST)

Status: design · Owner module: `apps/api/src/modules/guests` (parties, guests, groups, imports, dedupe) · Domain: `packages/domain/src/phone.ts`, `packages/domain/src/names.ts`, `packages/domain/src/import/` · SQL: [`sql/04-gst.sql`](./sql/04-gst.sql)

## 1. Summary

Hosts build the guest list in **Host mode of the RN app**: add parties (households/invites) with members and plus-ones by hand, import from Excel/CSV or a Google Sheet through one mapping → preview → commit pipeline running in **pg-boss**, pick people from the **phone's address book**, normalise phones with libphonenumber-js, find and merge duplicates, group/tag parties, search/filter, and export CSV.

| Story | Sprint (plan) | Sprint (proposed) |
| --- | --- | --- |
| GST-01 Add and edit guests in parties | S2 | S2 |
| GST-04 Phone normalisation | S2 | S2 |
| GST-02 Import from Excel/CSV | S3 | S3 (split 02a pipeline/API + 02b mobile mapping/preview) |
| GST-05 Dedupe and merge | S3 | **Split:** 05a in-import duplicate detection (S3, part of GST-02); 05b duplicate finder + merge of RSVP/travel data → **S9** (RSV/TRV tables don't exist in S3) |
| GST-06 Groups and tags | S3 | S3 |
| GST-07 Views and export | S3 | **Split:** 07a search, group/phone filters, CSV export (S3); 07b RSVP/travel/arrival filters → **S6** (after ARR) |
| GST-03 Google Sheets | S9 | S9 (link-only) |
| GST-08 Phone contacts | S9 | S9 (native address book) |

**Stack reinterpretation.** Backlog says "Contact Picker API on Android Chrome; vCard upload as fallback (iOS)". In the RN app we use the native address book (`react-native-contacts`) on both platforms, so the vCard fallback is dropped. "Console" = Host mode. Import parsing runs in the pg-boss worker (`default` queue), not a Python job.

## 2. Key decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Import pipeline | Staged: `import_jobs` + `import_rows` tables; jobs `parse → validate → commit`; host maps and previews between steps | Parse and insert in one request | 1,000 rows of messy data need preview, per-row errors and resumability; staging table makes the error report and "fix and re-run" trivial. |
| Parsers | `exceljs` (streaming reader) for .xlsx, `papaparse` for CSV (BOM/UTF-16 sniffing, delimiter detection) | SheetJS | exceljs is MIT with streaming; SheetJS community build licence/distribution changed. |
| File transport | Presigned PUT to S3 (`media_objects` kind `other`, `delete_after` 7 d), max 5 MB | Multipart upload through the API | Same path as every other upload; the worker reads from S3. |
| Phone normalisation | `libphonenumber-js/max` in `packages/domain` on the API; `libphonenumber-js/min` on mobile for live hints | Regex rules | Handles 0-prefix, `91…` without plus, `00` intl, landline detection; `max` metadata (~145 KB) stays server-side for app size. |
| Fuzzy duplicate detection | In TypeScript (`packages/domain/src/names.ts`): normalise Indian names (drop honorifics Mr/Mrs/Dr/Shri/Smt/Kumari/ji, transliteration folding aa→a, ee→i, w→v, th→t, sh→s…), block by surname key + first initial, Jaro-Winkler ≥ 0.92 within blocks | `pg_trgm` self-join | Measured: trigram self-join on 2,100 guests took **3.8–7 s** (EXPLAIN in §9). In-memory blocking on 2,000 names is < 50 ms and handles "Sharma/Sarma". Exact-phone dupes stay in SQL (4 ms). |
| Merge keeps RSVP/travel | Merge registry: modules that reference guests/parties register `reassignGuest(tx, from, to)` / `reassignParty(tx, from, to)` hooks; the merge runs them in one transaction | GST updates other modules' tables | Baseline: one owning module writes each table. |
| Duplicates across parties only | Same phone **within** a party is fine (shared family phone, ACC-03) | Unique phone per wedding | Grandparents often share one number with a child. |
| Groups attach to parties | Use core `party_groups`; "tags" = custom groups | Per-guest tags | Invites, visibility and announcements target parties; a second tagging system confuses hosts. |
| Google Sheets | **Link only**: host shares the sheet "Anyone with the link can view"; server fetches `https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>` | OAuth `spreadsheets.readonly` | Sensitive scope needs Google OAuth verification (weeks) and token storage; host already logged in with Google but incremental scope is still verification-gated. PO decision (§13). |
| Address-book import | Read contacts on device, host multi-selects, **only selected** name + numbers go to the API as an inline import job (`source='contacts'`) | Upload whole address book | DPDP minimisation and Play/App Store contact-data policy. Same preview/dedupe flow as files. |
| Guest list unit | Party list with members embedded, keyset by `(lower(label), id)` | Flat guest list | Hosts invite households; flat view offered as a toggle (client-side flatten). |
| Export | Synchronous streamed CSV (`text/csv`, ≤ 2,000 parties) with CSV-injection escaping; mobile saves with `react-native-blob-util` and opens the share sheet | Async export job to S3 | Small size; simpler; audited as `guest.export`. |
| Filters owned by other modules | `FilterContributor` registry: RSV/TRV/ARR register `{key, toSql(weddingId, value) => Prisma.Sql EXISTS(...)}` | Join their tables in GST | Keeps module boundaries; unregistered filter → 400 until that module ships. |

## 3. Data model

SQL: [`sql/04-gst.sql`](./sql/04-gst.sql). **Schema check passed** (`arch_gst`: 000 + 03 + 04 → `OK: 21 tables`; also 000 + 04 alone).

| Table | Change | Notes |
| --- | --- | --- |
| `parties` | + `city`, `notes` (host-only), `source`, `import_job_id`, `merged_into_party_id`, `updated_by`; plus-ones 0–20; index `(wedding_id, lower(label), id)`; trigram on `label` | Soft delete (core). |
| `guests` | + `phone_raw`, `phone_status` (`valid/invalid/missing/landline`), `relation`, `notes` (host-only), `merged_into_guest_id`, `updated_by`; E.164 format CHECK; status/phone consistency CHECK; index `(wedding_id, party_id) WHERE live`; partial index for non-valid phones | `phone_raw` kept so the host can fix an invalid number; nulled when fixed. |
| `guest_groups` | + `colour`, `sort_order`; unique `(wedding_id, system_key)` | Built-ins seeded on `wedding.created`. |
| `import_jobs` (new) | source, file_media_id / sheet_id+gid, status machine, headers, sheet_name, mapping (Zod), stats, error_code, `purge_after` (30 d) | Partial unique: one job per wedding in `parsing/validating/committing`. |
| `import_rows` (new) | row_number, party_key, raw, normalized, status, issues[], match_guest_id + match_kind, action (`create/merge/skip`), result, result_guest_id | Indexed for preview tabs and resumable commit. Purged with the job. |
| `guest_duplicate_dismissals` (new) | (wedding_id, guest_a < guest_b) | "Not a duplicate" memory. |

### Mapping schema (`packages/domain/src/import/mapping.ts`)

```ts
export const ImportField = z.enum([
  'fullName', 'firstName', 'lastName', 'phone', 'altPhone', 'email', 'partyLabel', 'partyKey',
  'members',        // "Ravi, Anita, 2 kids" in one cell → member rows
  'plusOnes', 'adults', 'children', 'groups', 'side', 'city', 'isOutstation', 'language',
  'relation', 'ageBand', 'notes', 'ignore']);
export const ImportMapping = z.object({
  sheetName: z.string().optional(),
  headerRow: z.number().int().min(1).max(20).default(1),
  columns: z.record(z.string(), ImportField),          // header → field
  partyMode: z.enum(['row_is_party', 'group_by_column']),  // one row per invite, or rows share a partyKey/partyLabel
  defaultRegion: z.string().length(2).default('IN'),
  createMissingGroups: z.boolean().default(true),
});
```

Auto-suggested mapping uses a header synonym list (English + Hinglish: "Naam", "Mob", "Mobile No.", "Contact", "WhatsApp", "Family", "Side", "Bride/Groom", "Ladke wale", "Ladki wale", "Pax", "Count").

### Phone normalisation (`packages/domain/src/phone.ts`)

```ts
normalizePhone(raw: string | number, defaultRegion = 'IN'):
  { e164: string | null; status: 'valid' | 'invalid' | 'missing' | 'landline'; warnings: PhoneWarning[] }
```
Rules: numbers from Excel (`9.845012345E9`) are converted without exponent; strip spaces, dashes, dots, brackets, leading `'`; `0` + 10 digits and `91` + 10 digits → India; `00` → international; two numbers in one cell (`/`, `,`, ` or `) → first wins, second returned as `altPhone` warning `PHONE_MULTIPLE`; fixed-line → `landline` (kept, flagged "no WhatsApp"); too short/long → `invalid`.

## 4. API

All under `/v1/weddings/:wid`. Permissions per [10-rol.md](./10-rol.md). Phones/emails/notes are masked by serialiser for roles without `guest.contact.read` (desk staff).

| Method | Path | Caller (permission) | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/parties?q=&groupId=&phoneStatus=&rsvp=&travel=&arrival=&cursor=&limit=` | `guest.read` | Party list with members; search name/label/last-4+ digits | `GST_FILTER_UNAVAILABLE` |
| POST | `/parties` | `guest.write` | Create party with members in one call | `GST_PRIMARY_REQUIRED`, `GST_PLAN_GUEST_LIMIT` (BIL later) |
| GET / PATCH / DELETE | `/parties/:pid` | read `guest.read`; write `guest.write` | Edit label, plus-ones, outstation, language, city, notes; soft delete | — |
| POST | `/parties/:pid/guests` | `guest.write` | Add member/plus-one | `GST_PHONE_INVALID` (only when host insists on strict) |
| PATCH / DELETE | `/guests/:gid` | `guest.write` | Edit / remove member; deleting primary requires `newPrimaryGuestId` | `GST_PRIMARY_REQUIRED` |
| POST | `/guests/:gid/move` | `guest.write` | Move member to another party | — |
| GET | `/guests/count` | `guest.read` | Totals: parties, guests, invalid phones, by group | — |
| GET / POST | `/groups` | read `guest.read`; write `group.write` | List with counts / create custom | `GST_GROUP_NAME_TAKEN` |
| PATCH / DELETE | `/groups/:gid` | `group.write` | Rename/colour; built-ins cannot be deleted | `GST_GROUP_BUILTIN` |
| POST | `/groups/:gid/parties` | `group.write` | Bulk add/remove `{op, partyIds[≤500]}` | — |
| POST | `/imports` | `guest.import` | Start import `{source, mediaId}` or `{source:'google_sheet', url}` or `{source:'contacts', rows[≤500]}` | `GST_IMPORT_IN_PROGRESS`, `GST_IMPORT_FILE_TOO_LARGE`, `GST_SHEET_URL_INVALID` |
| GET | `/imports/:iid` | `guest.import` | Status, headers, suggested mapping, stats (poll every 1 s) | — |
| PUT | `/imports/:iid/mapping` | `guest.import` | Submit mapping → validate job | `GST_IMPORT_MAPPING_INVALID` (no name column) |
| GET | `/imports/:iid/rows?status=&cursor=` | `guest.import` | Preview rows with issues and matches | — |
| PATCH | `/imports/:iid/rows` | `guest.import` | Set `action` per row or for all duplicates | — |
| POST | `/imports/:iid/commit` (`Idempotency-Key`) | `guest.import` | Commit → commit job | `GST_IMPORT_NOT_PREVIEW`, `GST_PLAN_GUEST_LIMIT` |
| GET | `/imports/:iid/errors.csv` | `guest.import` | Error report: original columns + `Row`, `Problem` | — |
| POST | `/imports/:iid/cancel` | `guest.import` | Cancel before commit | — |
| GET | `/duplicates` | `guest.merge` | Candidate pairs: exact phone (across parties) + fuzzy name | — |
| POST | `/duplicates/dismiss` | `guest.merge` | Mark pair not duplicate | — |
| POST | `/guests/:gid/merge` | `guest.merge` | `{intoGuestId, keep:{fullName:'source'|'target',…}}` | `GST_MERGE_SAME`, `GST_MERGE_CROSS_WEDDING` (404) |
| POST | `/parties/:pid/merge` | `guest.merge` | Move all members + data into target party | — |
| GET | `/guests/export.csv?…filters` | `guest.export` | Streamed CSV (masked per role) | — |

### Examples

`POST /v1/weddings/:wid/parties`
```json
{ "label": "Sharma family", "plusOnesAllowed": 1, "isOutstation": true, "city": "Lucknow",
  "groupIds": ["<Family>", "<Bride side>"],
  "members": [
    { "fullName": "Ravi Sharma", "phone": "098450 12345", "isPrimary": true, "relation": "Mama ji" },
    { "fullName": "Anita Sharma", "phone": "+91 98450 12345" },
    { "fullName": "Aarav", "ageBand": "child" } ] }
```
→ `201`
```json
{ "id": "p1…", "label": "Sharma family", "plusOnesAllowed": 1, "groups": [{ "id": "…", "name": "Family" }],
  "members": [
    { "id": "g1…", "fullName": "Ravi Sharma", "isPrimary": true, "phone": "+919845012345", "phoneStatus": "valid" },
    { "id": "g2…", "fullName": "Anita Sharma", "phone": "+919845012345", "phoneStatus": "valid" },
    { "id": "g3…", "fullName": "Aarav", "ageBand": "child", "phone": null, "phoneStatus": "missing" } ],
  "warnings": [] }
```
Desk staff receive the same shape without `phone`, `email`, `notes`, `relation` (field absent, not null).

`GET /v1/weddings/:wid/imports/:iid` (after parse)
```json
{ "id": "i1…", "status": "mapping", "source": "xlsx", "sheets": ["Guests", "Vendors"], "sheetName": "Guests",
  "headers": ["S.No", "Naam", "Mobile", "Family", "Side", "Pax"],
  "suggestedMapping": { "columns": { "S.No": "ignore", "Naam": "fullName", "Mobile": "phone", "Family": "partyLabel", "Side": "side", "Pax": "plusOnes" }, "partyMode": "group_by_column" },
  "sample": [["1", "Ravi Sharma", "9845012345", "Sharma", "Bride", "2"]], "stats": { "total": 1043 } }
```

`GET /v1/weddings/:wid/imports/:iid/rows?status=duplicate`
```json
{ "items": [ { "rowNumber": 14, "raw": { "Naam": "Ravi Sarma", "Mobile": "98450-12345" },
  "normalized": { "fullName": "Ravi Sarma", "phoneE164": "+919845012345" },
  "status": "duplicate", "match": { "guestId": "g1…", "fullName": "Ravi Sharma", "kind": "phone" }, "action": "skip" } ],
  "nextCursor": null }
```

## 5. Jobs, events and realtime

| Queue / name | Payload | Behaviour | Retries / idempotency |
| --- | --- | --- | --- |
| `default` · `gst.import.parse` | `{importId}` | Download file (S3) or sheet CSV (allowlisted fetch, 10 s, 5 MB); detect sheets/headers; store first 20 rows; suggest mapping; status `mapping`. Rejects > 5,000 rows (`GST_IMPORT_TOO_MANY_ROWS`). | 2 retries; `singletonKey=importId`. |
| `default` · `gst.import.validate` | `{importId}` | Re-read, apply mapping, normalise phones/names, group rows to parties, in-file dupes, match existing guests (phone exact via SQL; fuzzy via domain), write `import_rows` with `COPY`-style batched inserts of 500; status `preview`. | Deletes existing rows for the job first → rerunnable. |
| `default` · `gst.import.commit` | `{importId}` | Loop batches of 200 rows `WHERE result IS NULL` in a transaction each: create parties/guests/groups or merge (fill blanks only); set `result`; audit one `guest.import` entry with counts (not per row). Status `done`. | Resumable after crash (only unapplied rows); `Idempotency-Key` on the commit request. |
| `default` · cron `gst.import.purge` (daily) | — | Delete `import_jobs` past `purge_after` (rows cascade) and mark their media `delete_after = now()`. | Idempotent. |
| Domain event | `guest.created/updated/deleted`, `party.*`, `guests.imported {weddingId, partyIds}` | RSV headcount refresh, MSG audience caches, ACC link creation for new parties (ACC owns). | In-process. |
| Domain event (sync) | merge registry hooks | Called inside the merge transaction. | — |
| Realtime | none; the app polls import status every 1 s while on the progress screen | SSE not worth it for a 10–30 s job. | — |

## 6. Mobile app

**Host mode** (`apps/mobile/src/features/guests/`):

| Screen | Notes |
| --- | --- |
| `GuestList` | `FlashList` of party cards (label, member count, groups chips, phone warning icon); sticky search; filter sheet (group, phone problems; RSVP/travel/arrival once available); toggle party/flat view; multi-select → "Add to group", "Export". |
| `PartyEditor` | Members with primary radio, phone field with live `min`-metadata hint ("Will send to +91 98450 12345"), plus-ones stepper, outstation, language, groups, host notes. |
| `ImportStart` | Choose: File (`@react-native-documents/picker`, .xlsx/.csv) · Google Sheet link (paste) · Phone contacts. |
| `ImportMapping` | One row per source column: header, 3 sample values, field dropdown; party-mode switch; works one-handed on a 5.5" screen. |
| `ImportPreview` | Tabs: Ready · Warnings · Errors · Duplicates with counts; per-row action; "Skip all duplicates"; "Download error report"; Commit button with total. |
| `ImportProgress` | Progress bar from `stats`; done summary with "View imported" (filter `source=import`). |
| `ContactsPicker` | Permission rationale screen first (what is read, that only selected contacts leave the phone); searchable list from `react-native-contacts` (`getAll` with only name + phones, no photos/emails); multi-select; iOS 18 limited access supported. |
| `Duplicates` (05b) | Pair cards, side-by-side fields, choose values, Merge / Not a duplicate. |

- Query keys: `['parties', wid, filters]` (infinite), `['party', wid, pid]`, `['groups', wid]`, `['import', wid, iid]` (refetchInterval 1 s while running), `['importRows', wid, iid, status]`, `['duplicates', wid]`.
- Offline: guest list cached in MMKV for read at a venue; edits online-only (clear banner). Desk staff use ARR's check-in list, not this screen.
- Performance: 2,000 guests ≈ 700 parties → paginated 50 at a time; `FlashList` with fixed item heights; search debounced 250 ms, server-side.
- Accessibility: phone status shown with icon + text ("Invalid number"), not colour only; large-text layout for mapping rows stacks vertically.
- Android manifest: `READ_CONTACTS` requested at runtime only from `ContactsPicker`; Play Console data-safety form declares contacts "collected, not shared, user-selected only". iOS `NSContactsUsageDescription`.

## 7. Guest lite web

Not applicable: guest list management is host-only. (Guests never see other guests; the lite page reads only the party's own members via ACC/GH.)

## 8. Security and privacy

- **Purpose:** guest names and phones are processed for invitation and logistics (`core` consent purpose captured by ACC-04 when the guest opens the link). Hosts are the source; UI notice at import: "Only import people you're inviting; they'll be told how their data is used."
- **Minimisation:** contacts import sends only selected contacts' name + phones; import files deleted after 7 days, staged rows after 30 days; `phone_raw` cleared once a valid number is saved.
- **Masking:** desk staff never receive `phone`, `altPhone`, `email`, `notes`, `relation`, `phone_raw` (serialiser allowlist, see 10-rol.md). Desk staff have no access to imports, export or duplicates.
- **Export:** audited (`guest.export` with filter + row count); owner/co-host/planner only; CSV injection escaped (prefix `'` on cells starting `= + - @ \t \r`).
- **Google Sheets fetch:** only `docs.google.com/spreadsheets/d/<id>` accepted; server builds the export URL itself; follows redirects only to `*.googleusercontent.com`; 5 MB / 10 s caps; sheet URL never logged.
- **Files:** content type and magic bytes checked (xlsx = zip, csv = text); exceljs with formulas read as cached values only; zip-bomb guard (uncompressed ≤ 50 MB).
- **Audit:** `party.create/update/delete`, `guest.create/update/delete/move`, `guest.merge`, `party.merge`, `group.*`, `group.bulk_assign` (count), `guest.import` (counts), `guest.export`. Phone values masked to last 4 in diffs.
- **Rate limits:** imports 10/hour per wedding; export 20/hour per user.
- **Deletion:** host deletes a guest = soft delete now, hard delete by PRV-02 job within 7 days (scrubs audit diffs via redaction).

## 9. Scale and performance

| Target | How |
| --- | --- |
| 1,000 rows < 30 s end to end | Parse (streamed) ~1 s, validate ~1–2 s (phones via `max` metadata ~20 µs each; fuzzy blocking < 50 ms), commit in 5 batches of 200 with `createMany` ~2 s. Budget leaves room for a slow S3 GET. e2e test asserts < 10 s on CI for 1,000 rows. |
| 2,000-guest list | Keyset page on `parties_wedding_label_idx`: **0.4 ms** per page (EXPLAIN, 50 weddings × 700 parties). |
| Search | `wedding_id` + trigram BitmapAnd: **10 ms** for `ILIKE '%anita sh%'` over 105k guests. |
| Duplicates | Exact phone across parties: **4 ms** (GROUP BY on wedding slice). Trigram self-join measured **3.8 s** (pairs) → rejected; fuzzy in TS. |
| Worker contention | Import jobs on `default` queue with `teamConcurrency: 2`; never on `messaging` or `media`. |

## 10. Testing plan

| Level | What |
| --- | --- |
| Unit (domain) | `normalizePhone` table (≥ 40 cases: `9845012345`, `09845012345`, `919845012345`, `+91 98450-12345`, `(080) 2345 6789` landline, `+1 415…`, `0091…`, Excel float, two numbers in a cell, 9 digits); `names.ts` folding and blocking (`Sharma/Sarma`, `Mrs. Anita Sharma ji`); mapping suggestion from synonyms; CSV injection escaping. |
| API e2e | Party CRUD and primary rules; group bulk assign; import fixtures (`clean-50.xlsx`, `messy-500.xlsx` from the concierge pilot, anonymised; `utf16.csv`; `two-sheets.xlsx`; `1000-rows.csv` timing); preview actions; commit resumes after a forced crash mid-batch; error CSV contents; Google Sheet fetch against a stub server; contacts inline import; dedupe + merge with a fake registry hook; export masking per role; filters return `GST_FILTER_UNAVAILABLE` until registered. |
| Mobile | RNTL: PartyEditor primary toggle, phone hint; ImportMapping change; Preview tab counts; ContactsPicker permission denied path (mocked native module). |
| Device | File picker from WhatsApp "Documents" and Google Drive on Android 9; contacts permission + iOS limited access; 2,000-guest list scroll on 2 GB RAM. |

Fakes: `FakeObjectStore`, `FakeSheetFetcher`, mocked `react-native-contacts`.

## 11. Story breakdown

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| GST-01 Add/edit guests in parties | [DB] ALTER parties/guests · [API] parties/guests CRUD, primary rules, move, soft delete, serialiser with masking · [MOB] GuestList (basic), PartyEditor · [TEST] e2e + role masking | 3 → **5** | RN list + editor and masked serialisers built from day 1. |
| GST-04 Phone normalisation | [API/domain] `phone.ts` (max/min builds) · [TEST] 40-case table | 2 → **2** | Unchanged. |
| GST-02a Import pipeline + API | [DB] import_jobs/rows · [JOB] parse/validate/commit/purge · [API] imports endpoints, error CSV · [TEST] fixtures, 1,000-row timing, crash resume | 5 → **5** | — |
| GST-02b Import mobile flow | [MOB] ImportStart (file), Mapping, Preview, Progress · [TEST] RNTL | (in 02) → **3** | Mapping/preview UI on a phone is real work. |
| GST-05a In-import duplicates | [JOB] in-file + existing match (phone exact, fuzzy) · [API] row actions | (in 05) → **1** | Small given `names.ts`. |
| GST-05b Duplicate finder + merge | [API] duplicates, dismiss, guest/party merge + registry · [MOB] Duplicates · [TEST] merge with RSV/TRV hooks | 3 → **4** | Cross-module merge registry; must wait for RSV/TRV → S9. |
| GST-06 Groups and tags | [DB] group columns · [API] groups CRUD, seed, bulk assign · [MOB] group chips, multi-select bulk · [TEST] | 3 → **3** | Unchanged. |
| GST-07a Search, filters, export | [API] search, group/phone filters, `FilterContributor` registry, CSV stream · [MOB] filter sheet, export share · [TEST] | 3 → **3** | — |
| GST-07b Status filters | [API] RSV/TRV/ARR contributors (each module adds its own) · [MOB] filter chips | (in 07) → **1** | Lands with ARR in S6. |
| GST-03 Google Sheets (link) | [JOB] sheet fetcher with allowlist · [API] url parse · [MOB] paste flow · [TEST] stub | 3 → **2** | Link-only reuses the pipeline. **5** if OAuth is chosen. |
| GST-08 Phone contacts | [MOB] ContactsPicker, permission rationale, iOS limited access, Play data-safety · [API] inline rows source · [TEST] | 3 → **3** | Native instead of web Contact Picker; vCard dropped; permission/store-policy work offsets. |
| **Total** | | **25 → 32** | |

## 12. Dependencies and sequencing

| Needs | From | Note |
| --- | --- | --- |
| Weddings, built-in group seeding call | SET-01 (S2) | |
| `can()`, `requireWeddingRole`, `audit.record`, serialiser masking helpers | ROL-02a, ROL-03a (S2) | |
| Upload core (presign/complete, `FakeObjectStore`) | CAM-01 slice pulled to S2/S3 | GST-02 can't take a file otherwise. |
| pg-boss worker | FND-06 (S1) | |
| Merge hooks | RSV (S4), TRV (S6), ARR (S6), ROM/IDV later | Each module's design must register `reassignGuest`/`reassignParty`. |
| Filter contributors | RSV-01, TRV-01, ARR-01 | GST-07b in S6. |
| Party link creation for new parties | ACC-01 (S4) | ACC listens to `guests.imported` / `party.created`. |
| Plan guest limit | BIL-01 (later) | Hook `entitlements.assertGuestCapacity` no-op until then. |

## 13. Risks and open questions

| # | Item |
| --- | --- |
| R1 | **No host web console**: mapping a 1,000-row sheet on a phone is cramped. Mitigation: smart auto-mapping, preview-by-exception. PO may want a minimal host web import page (P1). |
| R2 | Google Sheets link-only requires the host to change sharing to "anyone with link" — privacy-wise awkward; UI tells them to turn it off afterwards. |
| R3 | Play Store contacts policy review may delay release; prepare prominent-disclosure screen and data-safety answers early (APP/OPS). |
| R4 | Fuzzy name rules for Indian names need tuning on real pilot data (VAL-05 sheet). |
| Q1 | PO: Google Sheets OAuth (verification + 3 pts more) or link-only for pilots? |
| Q2 | PO: is the S3 holiday sprint OK with 05b and 07b moved out? |
| Q3 | Should desk staff be able to add a walk-in guest at the desk (ARR)? Matrix currently says no (`guest.write` denied). |

## 14. Deviations from the baseline

1. **Proposed:** add `'import'` to the `media_objects.kind` CHECK in core. Until then import files use kind `other` with `delete_after = now() + 7 days`.
2. Fuzzy duplicate detection runs in TypeScript, not with `pg_trgm` (core's trigram index is still used for search).

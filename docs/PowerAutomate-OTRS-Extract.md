# PowerAutomate: OTRS Support-Case Extractor

Reference guide for the Power Automate developer responsible for the scheduled OTRS → wiki extraction flow. The architecture background is in [Architecture §9](Architecture.md#9-otrs-support-case-pipeline); the admin-facing ops (app settings, secret rotation, state blob) are in [Administration §11](Administration.md#11-otrs-extractor-operations).

## What this flow does

The Function App hosts two HTTP routes that together move resolved D365 support tickets from OTRS into a wiki:

| Route | Purpose | Status |
|-------|---------|--------|
| `POST /api/otrs/extract` | Pulls validated tickets from OTRS, returns them as XML | **Available today** |
| `POST /api/otrs/ingest` | Parses XML from the extractor, writes markdown pages into the wiki container | *Future CR — not yet deployed* |

Power Automate is the glue: **it calls the extractor, then forwards the XML body to the ingestor.** The two routes never talk to each other directly — this keeps both sides stateless and lets Power Automate add retries, notifications, or a review step between them.

> **Scope of this document:** the extractor (Function A). The ingestor (Function B) will get its own section once it ships.

## Prerequisites

1. **Function key** — Azure Portal → `tis-p-mcpd365fo-func` → **App keys** → **default** → copy value. Paste into the Power Automate HTTP action's *Authentication* or append as `?code=<key>` in the URL. (See [Administration §11.1](Administration.md#111-app-settings) for the auth model.)
2. **OTRS_PASSWORD set on the Function App** — done once by the admin per [Administration §11.2](Administration.md#112-setting-the-otrs-password). If it's missing you will see a `500` with `"Missing OTRS config: OTRS_PASSWORD"`.
3. **Connectors used:** only the built-in **HTTP** action and (optionally) the **Recurrence** trigger and **Office 365 Outlook / Teams** for failure notifications. No premium connector is required.

## Flow design

```
┌───────────────────────────────────────────────────────────┐
│  Trigger: Recurrence (daily 02:00) or manual              │
├───────────────────────────────────────────────────────────┤
│  1. HTTP: POST /api/otrs/extract                          │
│     Body: { "mode": "incremental" }                       │
│     → response: XML envelope + X-OTRS-* headers           │
├───────────────────────────────────────────────────────────┤
│  2. Condition: outputs('Extract')?['X-OTRS-Extracted']    │
│                                    not equal to '0'       │
│     ├─ Yes: POST /api/otrs/ingest                         │
│     │       Body: outputs('Extract')?['body']             │
│     │       Content-Type: application/xml                 │
│     └─ No:  terminate (nothing new this cycle)            │
├───────────────────────────────────────────────────────────┤
│  3. Condition: outputs('Extract')?['X-OTRS-Skipped']      │
│                                    greater than '0'       │
│     └─ Yes: notify (Teams / email) with XML <Skipped>     │
│             block for data-quality follow-up              │
└───────────────────────────────────────────────────────────┘
```

## Extractor endpoint

### Method, URL, auth

| Field | Value |
|-------|-------|
| Method | `POST` |
| URL | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/otrs/extract` |
| Auth | Function key — header `x-functions-key: <key>` **or** query string `?code=<key>` |
| Content-Type | `application/json` |

### Request body

```json
{
  "mode": "incremental",
  "limit": 100
}
```

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `mode` | `"incremental"` \| `"full"` \| `"preview"` | `"incremental"` | See [mode selection](#mode-selection) below |
| `limit` | integer ≥ 1 | *(none — all candidates)* | Caps the number of `TicketGet` calls this run (useful to stage a large backfill over multiple runs) |

An empty body `{}` or missing body is valid — it means `mode: "incremental"`, no limit.

### Response — success

- **Status:** `200 OK`
- **Content-Type:** `application/xml; charset=utf-8`
- **Headers (always present):**
  - `X-OTRS-Extracted` — validated tickets in the `<Ticket>` nodes (the number Power Automate should forward to the ingestor)
  - `X-OTRS-Skipped` — tickets that failed validation or fetch
  - `X-OTRS-Candidates` — total tickets considered this run (extracted + skipped)
- **Body:** the `<OtrsExtract>` XML envelope (schema below)

### Response — error

- **Status:** `400` (bad JSON body), `401` (bad/missing key), `500` (OTRS down, missing config, etc.)
- **Content-Type:** `application/json`
- **Body:** `{ "error": "<message>", "hint": "<actionable hint>" }`

Per-ticket fetch/validation errors **do NOT cause a `500`** — they appear inline under `<Skipped>` so the whole run succeeds as long as OTRS is reachable.

### XML response schema

```xml
<?xml version="1.0" encoding="utf-8"?>
<OtrsExtract generatedAt="2026-04-17T02:00:03.812Z"
             mode="incremental"
             count="2"
             skippedCount="1">
  <Ticket id="1721474"
          number="2026040512345678"
          title="Sales order post fails with NumberSeq error"
          queue="D365 Support"
          service="TIS - Digital Solutions Support::ERP::D365"
          priority="3 normal"
          closedAt="2026-04-10 14:33:00">
    <Description><![CDATA[When posting a sales order we see
"Number sequence is not set up". Steps to reproduce: …]]></Description>
    <Resolution><![CDATA[Navigate to Sales & marketing parameters →
Number sequences → assign a new reference …]]></Resolution>
    <Articles>
      <Article sender="customer"
               from="user@trelleborg.com"
               createdAt="2026-04-05 10:00:00"><![CDATA[original customer message]]></Article>
      <Article sender="agent"
               from="agent@trelleborg.com"
               createdAt="2026-04-10 14:30:00"><![CDATA[step-by-step resolution]]></Article>
    </Articles>
  </Ticket>
  <Ticket id="1720411" …>…</Ticket>
  <Skipped>
    <Ticket id="1719376" reason="agent-article body total is 80 chars, minimum 200 (resolution too thin)"/>
  </Skipped>
</OtrsExtract>
```

### Field reference

| Element / attribute | Notes |
|---------------------|-------|
| `OtrsExtract/@generatedAt` | UTC ISO-8601; the time the extractor finished the batch |
| `OtrsExtract/@mode` | Echoes the request body's `mode` |
| `OtrsExtract/@count` | Number of `<Ticket>` children (same as `X-OTRS-Extracted`) |
| `OtrsExtract/@skippedCount` | Number of entries under `<Skipped>` (same as `X-OTRS-Skipped`) |
| `Ticket/@id` | OTRS `TicketID` — the canonical key the wiki uses as filename |
| `Ticket/@number` | OTRS `TicketNumber` — the human-facing case number |
| `Ticket/@closedAt` | Raw `Closed` / `ChangeTime` value from OTRS (no TZ normalization) |
| `Description` | First customer article body, trimmed; wrapped in CDATA |
| `Resolution` | All agent article bodies, oldest first, joined by `\n\n---\n\n`; wrapped in CDATA |
| `Articles/Article` | Full article trace — customer + agent + system — preserving `sender`, `from`, `createdAt` |
| `Skipped/Ticket/@reason` | Human-readable — one of: wrong state, no customer article, no articles, resolution too thin, fetch error |

The `]]>` sequence inside any body is escaped by splitting the CDATA into two adjacent sections (`]]]]><![CDATA[>`), so the XML stays valid for every possible ticket text.

## Mode selection

| Mode | Filter | Writes state blob? | Use it when |
|------|--------|--------------------|-------------|
| `incremental` | Skips IDs already in `processedTicketIds` | Yes (appends new IDs) | Every scheduled run — this is the default |
| `full` | Ignores `processedTicketIds` — returns everything that matches the OTRS filter | Yes (appends new IDs) | First deployment to backfill the wiki, or after the wiki storage was wiped |
| `preview` | Same filter as `incremental` | **No** | Manual dry-run from the Power Automate test panel, health check, validating a filter change before committing state |

> **Do not run `full` on the recurring schedule** — it costs one `TicketGet` per ticket ever closed for this service. Use `full` once, then switch to `incremental`.

## Step-by-step configuration

### Step 1 — Recurrence trigger

| Field | Value |
|-------|-------|
| Interval | 1 |
| Frequency | Day |
| Start time | 02:00 Europe/Warsaw (off-peak for OTRS) |

### Step 2 — HTTP: Extract

| Field | Value |
|-------|-------|
| Method | `POST` |
| URI | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/otrs/extract?code=@{parameters('otrsExtractKey')}` |
| Headers | `Content-Type` = `application/json` |
| Body | `{ "mode": "incremental" }` |

**Tip:** store the function key as a Power Automate *environment variable* (`otrsExtractKey`) rather than hard-coding it in the URL — rotating the key is then a single edit, not a flow change.

*(Rename this action to `Extract` so the expressions below stay readable.)*

### Step 3 — Branch on "anything to ingest?"

**Condition:** `int(outputs('Extract')?['headers']?['X-OTRS-Extracted'])` **is greater than** `0`

- **If yes:** proceed to Step 4.
- **If no:** **Terminate** with status `Succeeded` — nothing new this cycle.

### Step 4 — HTTP: Ingest

*(Available once Function B ships — placeholder today; the extractor can be smoke-tested without this step.)*

| Field | Value |
|-------|-------|
| Method | `POST` |
| URI | `https://tis-p-mcpd365fo-func.azurewebsites.net/api/otrs/ingest?code=@{parameters('otrsIngestKey')}` |
| Headers | `Content-Type` = `application/xml` |
| Body | `@{body('Extract')}` |

### Step 5 — Branch on skipped tickets (optional but recommended)

**Condition:** `int(outputs('Extract')?['headers']?['X-OTRS-Skipped'])` **is greater than** `0`

- **If yes:** **Post a message (Teams)** or **Send an email** with the `<Skipped>` block so data-quality issues get visibility. The reason strings are written to be read by a human.

## Parsing XML in Power Automate

The cleanest approach in Power Automate is to **treat the body as opaque** in the happy path — just forward `@{body('Extract')}` to the ingestor. You only need to parse when you want to branch on content (e.g. "alert on skipped tickets").

To inspect `<Skipped>`, use the `xml()` and `xpath()` functions:

```
// Count of skipped tickets (matches X-OTRS-Skipped header)
int(
  xpath(
    xml(body('Extract')),
    'count(/OtrsExtract/Skipped/Ticket)'
  )
)

// First skipped reason as a string
string(
  xpath(
    xml(body('Extract')),
    'string(/OtrsExtract/Skipped/Ticket[1]/@reason)'
  )
)

// Array of skipped ticket IDs
xpath(
  xml(body('Extract')),
  '/OtrsExtract/Skipped/Ticket/@id'
)
```

Prefer the `X-OTRS-*` response headers for branching — they're free, server-authoritative, and don't require XPath. Use XPath only when you need the content of a specific element.

## Testing the flow

1. **Health check without side effects** — run Step 2 standalone with body `{ "mode": "preview", "limit": 1 }`. Power Automate's *Test → Manually* shows the full XML body and headers. No state is written.
2. **First production run** — use `{ "mode": "full", "limit": 25 }` once to stage a safe backfill. Check the state blob exists in the `otrs-state` container and contains the 25 IDs. Raise `limit` on subsequent runs, or drop it entirely, as confidence grows.
3. **Switch to daily** — once the state blob is populated, the recurring flow can use `{ "mode": "incremental" }` indefinitely.

## Failure modes to handle in the flow

| Extractor returns | Your flow should | Rationale |
|-------------------|------------------|-----------|
| `200` + `X-OTRS-Extracted > 0` | Forward body to ingestor | Normal happy path |
| `200` + `X-OTRS-Extracted = 0` + `X-OTRS-Skipped = 0` | No-op; terminate success | OTRS had nothing new this cycle |
| `200` + `X-OTRS-Skipped > 0` | Notify data-quality channel | Tickets were closed without a documented resolution — fix upstream |
| `400` | Notify operator; do NOT retry | Bad request body — retrying won't help |
| `401` | Notify operator; do NOT retry | Function key wrong or rotated |
| `500` | Retry with exponential backoff (max 3) | Transient OTRS / Azure issue; the run is idempotent under incremental mode |

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [Architecture](Architecture.md) | System design — §9 covers the OTRS pipeline |
| [Administration](Administration.md) | §11 — OTRS extractor operations (app settings, state blob, troubleshooting) |
| [PowerAutomate — Security DB update](PowerAutomate-SecDatabase-Update.md) | The other Power Automate flow on this Function App (daily DMF refresh) |
| [PowerAutomate — Admin Guide](PowerAutomate-Admin-Guide.md) | Shared Power Automate configuration patterns |
| [README](../README.md) | Project overview and quick start |

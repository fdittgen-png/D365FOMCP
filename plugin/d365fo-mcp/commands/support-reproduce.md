---
description: Builds a step-by-step reproduction scenario from a Task Recording (.axtr) or issue description, enriched with form/table context for 1st-level support. Also covers safe live-environment reproduction via OData/integration replay. Use when a ticket needs a repro scenario or an integration payload must be replayed.
argument-hint: <path\to\recording.axtr | issue description>
---

# Support: Reproduce Issue from Task Recording

## Task
Build a reproduction scenario from `$ARGUMENTS`.
**Done when:** a support engineer can follow the steps using only the labels and values in the document, and every live-replay step respects the Boundaries below.

## Workflow

### Step 1: Parse the recording
**If .axtr path:** read the file, base64-encode it, call `d365taskrecorder:taskrecorder_to_markdown` with file_content and file_name.
**If description only:** ask for the .axtr, or use `d365kb:d365_search` to find the forms/tables of the described area.

### Step 2: Enrich with form context (parallel)
Per form in the recording: `d365kb:d365_lookup_table` for the primary data source (what the form shows), `d365kb:d365_search` for related setup forms.

### Step 3: Build the reproduction document

**Support Reproduction Scenario**
- **Issue Area / Environment / Date Recorded**
- **Prerequisites:** required security roles, navigation path
- **Steps to Reproduce:** numbered, plain language — "Navigate to **[Menu Item Label]**", "Enter **[value]** in **[field label]**", with *Technical: Table.Field = value* subnotes
- **Expected Result / Actual Result** (ask the user if not in the ticket)
- **Technical Context:** forms, tables, key fields involved

## Live reproduction via OData / integration replay
When the repro is a payload replay (e.g. Basware → D365 vendor invoices) rather than a UI recording — full payload shapes, error taxonomy, and environment gotchas live in `the `basware-d365-vendor-invoice-integration` skill`. The non-negotiable core:

1. **Full export ≠ integration payload.** A captured read-back (odata.context/etag) is the full entity; re-POSTing it fails on serialization (`IEEE754Compatible` → send numerics as JSON numbers; `Edm.Int32` rejects `0.0`) and on read-only fields (403 `insert not allowed for field X` → restrict to the integration's actual field set). Confirm types/insertability with `d365kb:d365_lookup_table` + `d365kb:d365_get_entity_sources` BEFORE posting.
2. **DryRun before every live POST** — build the payload without HTTP, inspect the JSON against metadata. A POST that fails after a parent posted leaves an orphan header plus custom staging rows that deletion does NOT clear. Scope to one record/PO; never batch on the first live attempt.

## Boundaries
- **Privacy (non-negotiable):** never read live consumer/vendor financial records into the session. Hand the user a read-only run-it-yourself script keyed by known IDs (InvoiceId, dataAreaId), never a bulk export; have them paste back only privacy-safe scalars.
- Treat any credential the user pastes as compromised: use it inline for the call, advise rotation, never store or echo it.

## Follow-ups to offer
- Who can reproduce this (`d365sec:sec_find_users_by_role`), process documentation (`/d365-research`), or the code behind the action (`d365xref:xref_find_method_callers`)

---
description: Resolves a D365FO label end-to-end — from a label id or a UI string to its text in every language, its developer description, the objects and properties that show it (form, field, menu item, duty, privilege) and, on request, who may reach that object — in 2–4 MCP calls. Use when a ticket quotes a screen text, a label id leaks into a document, or a text must be changed safely.
argument-hint: <@LabelFile:Key | @SYS12345 | "text as shown on screen"> [--languages de,fr] [--who]
---

# D365 Label (id or UI text → objects → access)

> **Do not load `d365fo-mcp-tooling` for this command** — it carries its own calls. Labels answers are small (a lookup ≈ 300–600 tokens per id and language set); the skill text would cost more than the data.

## Task
Explain the label `$ARGUMENTS`: what it says, what it is for, where it is shown, and — only with `--who` — who can reach the object that shows it.
**Done when:** every object named comes from a where-used call, the languages shown are the ones asked for (default en-US plus the developer description), and the answer states what it did not cover (where-used needs the XRef snapshot; a UI string may map to several ids).

## Workflow (target: 2–4 calls)

State the shape first: *"Shape: id → text + description → where used; text → candidate ids → where used."*

### Step 1 — Identify the label
- **Given an id** (`@AccountsPayable:VendRecurringInvoiceMaintain`, `@SYS154828`, `SYS154828`): `d365labels:labels_lookup` with `label_ids: [<id>]` and `languages` from `--languages` (default `["en-US"]`). Several ids in one call — one id is a batch of one.
- **Given a screen text**: `d365labels:labels_search` with `text` = the quoted string, `language` when the user's UI language is known, `limit: 20`. Prefer an exact-text match; when several ids match, keep the ones whose label file fits the module in question and say the choice was made. Never page past two pages — narrow with `label_file`, `modules` or `origin` instead.

### Step 2 — Where it is shown
- `d365labels:labels_where_used` with `label_id` = the id from step 1, `limit: 50`. Read the **property** column: `Label` / `Caption` = what the user sees, `HelpText` = the status-bar text, `DeveloperDocumentation` = internal, `Code` = an X++ use. Filter with `property` or `object_type` (form, menu_item, table, duty, privilege) when the list is long.
- The other direction — "what does this form say?" — is `d365labels:labels_for_object` with `object_type` and `object_name`.

### Step 3 — Only with `--who`
- For a **menu item** or **form** found in step 2: `d365sec:sec_object_access` with the object name (pass the menu item or table, never a data entity) — roles that reach it, Deny included.
- For a **duty** or **privilege** found in step 2: `d365sec:sec_find_roles_by_duty` / `sec_find_roles_by_privilege`.

### Step 4 — Only when the text is to be changed
- Count the uses per property from step 2 before proposing a change: one label id can serve a field, a form caption and a report column at once. Say which objects would change.

## Output
1. **The label**: id, label file and module, origin (Microsoft / ISV / custom), the text in each requested language, the developer description verbatim (it is the author's statement of intent)
2. **Where it is shown**: objects grouped by property (what the user sees first), counts when the list was cut, `next_cursor` noted
3. **Who reaches it** (`--who` only): roles per object, Deny called out
4. **Change impact** (only when a change is in scope): objects that would change with it
5. **Not verified here**: languages not requested, uses outside the XRef snapshot, candidate ids not chosen for a text search

Quote the snapshot dates from the banners (Labels and, for where-used, XRef). A label id that the lookup does not know is a data gap to report, not a text to invent.

## Follow-ups to offer
- The same label in all 75 languages (`labels_lookup` without `languages`)
- Every label of the form or table (`labels_for_object`)
- The security trace for one role (`/d365-security <role>`)

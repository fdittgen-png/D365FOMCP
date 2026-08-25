# Part 3: Task Recorder Integration

_Reference for the `d365fo-support-scoping` skill. Read on demand._


### How to Use taskrecorder_to_markdown

The Task Recorder MCP tool parses .axtr files (ZIP archives) into structured Markdown.

**CRITICAL: When you see an .axtr file path, call `taskrecorder_to_markdown` DIRECTLY.**
Do NOT read the file first. Do NOT try to open it. The MCP service handles everything.

**For local files:** Read the file binary with the Read tool, then pass the content as base64 via `file_content`. Or use Bash to base64-encode and pass the result.

**For URLs:** Pass the URL directly as `file_url`. The service downloads and parses it.

**What the tool returns** (9 structured sections):
1. **Overview** — Recording name, description, total actions, breakdown by type
2. **Forms Visited** — AOT form names, menu item labels, menu item types
3. **Recorded Steps** — Each step with action type, control, form, value entered
4. **Subtasks** — Named sub-processes within the recording
5. **Validations** — Validation checkpoints
6. **Data Entry Summary** — All fields with values entered (control, AOT field, value, type)
7. **Data Sources (BPM)** — Tables used by each form (from BPM metadata)
8. **Security Roles (BPM)** — Required roles, duties, privileges, access levels
9. **Navigation Flow** — Form-to-form transition diagram

**What to extract for scoping:**
- **Forms Visited** → Affected modules and processes. Use `microsoft_docs_search("D365 [form_label]")` to get official documentation per form.
- **Data Sources** → Tables to investigate with `d365_lookup_table`
- **Security Roles** → Roles to check with `sec_lookup_role` / `sec_permission_trace`
- **Data Entry Summary** → Fields to verify with `d365_check_field_exists`
- **Navigation Flow** → Process flow for reproduction steps

**Enrichment pattern after parsing:**
```
1. taskrecorder_to_markdown → get structured output
2. PARALLEL per form in Forms Visited:
     d365_lookup_table(primaryTable)  |  microsoft_docs_search("D365 [form_label]")
3. PARALLEL per role in Security Roles:
     sec_lookup_role(roleName)
4. For key MS Learn results: microsoft_docs_fetch(url) for full page content
```


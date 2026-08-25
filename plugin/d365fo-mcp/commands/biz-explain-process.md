---
description: Explains a D365FO business process as a plain-language step-by-step guide for business users — from a process name or a Task Recording (.axtr). Use when a non-technical user asks how to perform a process; no code, no technical jargon in the output.
argument-hint: <process name | path\to\recording.axtr>
---

# Business: Explain Process

## Task
Explain the process in `$ARGUMENTS` so a business user can follow it unaided.
**Done when:** every step uses form/field/button labels (never AOT names), each step says why it matters, and prerequisites (role, navigation path) are stated up front.

## Workflow

### Step 1: Get process information
**If .axtr file provided:** call `d365taskrecorder:taskrecorder_to_markdown` directly with the file content (base64) and file name — do NOT try to read/parse the .axtr yourself. Use the step descriptions and form/field labels from the result.

**If process name provided:**
- `d365rag:rag_ask` with the process name — internal documentation _(if the d365rag MCP is connected)_
- `Microsoft Learn:microsoft_docs_search` with "[process] D365 Finance Operations" — official user guides

### Step 2: Enrich with context
- `d365kb:d365_lookup_table` for the main form's table — only to get human-readable field labels
- `microsoft_docs_fetch` for the most relevant help page

## Output

**How to: [process]**
- **What this process does:** 2-3 sentence plain-language summary
- **Before you start:** required security role (display name), navigation path (**Module > Menu path**)
- **Step-by-step guide:** numbered steps using **[Form/Button/Field labels]**, with what to enter and why; for lookups/dropdowns, say what values to expect
- **What happens next:** downstream effects in business terms
- **Common questions:** likely errors and their resolution; approval/workflow info if applicable

## Boundaries
- Only field labels, form titles, and role display names — never technical identifiers
- If a step's purpose could not be verified from documentation or the recording, mark it "(verify with your key user)" rather than inventing a rationale

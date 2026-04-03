# Business: Explain Process

Explain a D365 business process in plain, non-technical language. Converts Task Recordings or process names into step-by-step guides that business users can follow. No code, no technical jargon.

## Arguments
- $ARGUMENTS: Process name OR .axtr file path (e.g., "how to create a purchase order", "vendor payment process", "C:\recordings\create-po.axtr")

## Workflow

### Step 1: Get process information

**If .axtr file provided:**
- Read and `taskrecorder_to_markdown` — get the recorded steps
- Use the step descriptions, form labels, and field labels (NOT technical names)

**If process name provided:**
- `rag_ask` with "$ARGUMENTS" — find internal documentation
- `microsoft_docs_search` with "$ARGUMENTS D365 Finance Operations" — official user guides

### Step 2: Enrich with context
For the main form involved:
- `d365_lookup_table` — only to get human-readable field labels for context
- `microsoft_docs_fetch` for the most relevant help page

### Step 3: Present in business language

**How to: $ARGUMENTS**

**What this process does:**
(2-3 sentence plain-language summary)

**Before you start:**
- You need the **[Role Name]** security role (from BPM data)
- Navigate to: **[Module] > [Menu path]** (from menu item label)

**Step-by-step guide:**
1. Open **[Form Label]**
   - You'll see a list of [what the form shows]
2. Click **[Button Label]** to [what it does]
3. Fill in the following:
   - **[Field Label]**: [what to enter and why]
   - **[Field Label]**: [what to enter and why]
4. Click **[Button Label]** to [what it does]

**What happens next:**
- (downstream effects in business terms)

**Common questions:**
- "What if I see an error?" → [common resolution]
- "Who else needs to approve?" → [workflow info if applicable]

**Need help?**
- Contact [support] for access issues
- See [link] for detailed documentation

### Important
- Use ONLY field labels and form titles, never AOT names
- Use ONLY role display names, never technical role IDs
- Explain WHY each step matters, not just WHAT to click
- If a step involves a lookup or dropdown, explain what values to expect

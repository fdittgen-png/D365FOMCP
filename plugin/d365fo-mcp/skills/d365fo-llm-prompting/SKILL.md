---
name: d365fo-llm-prompting
description: Prompt-engineering strategies specific to D365FO LLM work — failure modes, prompt architecture, templates, skill-file context injection, validation checklist. Use when crafting prompts or building LLM tooling for D365FO SQL, X++, or documentation tasks.
---

# D365FO LLM Prompt Engineering Skill

## Contents
- Overview
- Part 1: Why D365FO Is Hard for LLMs
- Part 2: Prompt Architecture for D365FO
- Part 3: Prompt Templates
- Part 4: Skill File References for Context Injection
- Part 5: Validation Checklist
- Part 6: Common Anti-Patterns
- Part 7: Model-Specific Notes

## Overview

Strategies for crafting effective prompts when using LLMs (Claude, GPT, etc.) for D365FO development tasks — particularly SQL queries, X++ analysis, and technical documentation. Based on empirical validation of LLM failure modes specific to D365FO.

---

## Part 1: Why D365FO Is Hard for LLMs

### 1.1 The Core Problem

D365FO is one of the worst domains for LLM accuracy because:

1. **Training data contamination**: AX2009, AX2012, and D365FO coexist in training data. Field names changed between versions (e.g., `PaymTermId` → `Payment`), but the LLM cannot distinguish which version a name belongs to.

2. **Sparse D365FO-specific content**: Most online D365FO content is in blogs and forums (often with errors), not in structured documentation. Microsoft's official docs omit SQL-level details.

3. **Complex composite keys**: D365FO uses 4-5 field composite keys for invoice header-to-line joins. No other major ERP uses keys this wide, so LLMs default to 2-3 field joins from general experience.

4. **Cross-company exceptions**: Most tables use `DATAAREAID`, but critical tables like `GeneralJournalEntry` don't — and the alternative filter field (`SUBLEDGERVOUCHERDATAAREAID`) is non-obvious.

5. **Enum-as-integer storage**: Status fields like `StatusIssue`, `StatusReceipt`, `AccountType` are stored as integers. LLMs often guess wrong enum values or invent text-based values.

### 1.2 Measured Error Rates (From Validation)

From a real-world test of LLM-generated D365FO SQL (Sonnet 4.6, February 2026):

| Error Category | Rate | Examples |
|---------------|:----:|---------|
| Wrong column names | 12.5% of all columns referenced | CustAccount, PurchOrderFormNum, IsDebit |
| Incomplete joins | 75% of header-line joins | Missing SalesId, PurchId, InternalInvoiceId |
| Non-existent fields | 6 fabricated fields | Direction, SubledgerVoucherType, AmountCurDebMST |
| Wrong table for field | 1 instance | POSTED on LedgerJournalTrans vs LedgerJournalTable |

---

## Part 2: Prompt Architecture for D365FO

### 2.1 The "Verify Before Generate" Pattern

The single most effective strategy: **force the LLM to verify before writing code**.

**Without access to DB or metadata** (most common scenario):

```
STEP 1 - For each table, list the FULL composite primary key /
relation key. Explain how you know the join is complete. If uncertain
about any join field, say so explicitly.

STEP 2 - For every column, mark your confidence:
  [CERTAIN] = very sure this is the D365FO 10.0 SQL name
  [CHECK]   = may have been renamed from AX2012 or vary by version
List any known AX2012-to-D365FO renames relevant to these tables.

STEP 3 - Write the final SQL. Add a comment next to any [CHECK] column.
```

**With access to DB**:

```
BEFORE writing any SQL, query INFORMATION_SCHEMA.COLUMNS for each
table to get the real column names. Do NOT guess field names from memory.
Validate each query with TOP 5 before delivering the final version.
```

**With access to PackagesLocalDirectory metadata**:

```
BEFORE writing any SQL, read the AxTable XML definitions for each table.
Check the <AxTableRelation> sections for complete join key definitions.
Verify field names from <AxTableField> elements, not from memory.
```

### 2.2 The "Negative Instruction" Pattern

Explicitly close known failure modes:

```
- Do NOT use AX2012 field names. Key renames: CustAccount→OrderAccount,
  PaymTermId→Payment, PurchOrderFormNum→PurchaseOrder
- Do NOT invent fields that don't exist (e.g., DIRECTION on InventTrans —
  derive from QTY sign instead)
- Do NOT use PARTITION subqueries for GeneralJournalEntry — use
  SUBLEDGERVOUCHERDATAAREAID
- Do NOT assume IsDebit exists — the field is ISCREDIT with inverted logic
```

### 2.3 The "Targeted Hint" Pattern

For known non-obvious traps, give explicit hints rather than hoping the LLM will figure them out:

```
GeneralJournalEntry is cross-company (SaveDataPerCompany = No).
It has NO DATAAREAID column. Explain how to filter by legal entity
using the table's own fields.
```

```
CustInvoiceTrans → CustInvoiceJour is a 4-field composite key join,
not 3. VendInvoiceTrans → VendInvoiceJour is a 5-field composite key.
Include ALL join fields.
```

### 2.4 The "No Persona" Principle

**Avoid**: "You are a senior D365FO technical consultant with 15 years experience..."

**Why**: Persona priming makes the LLM more confident, not more accurate. For D365FO, where the model's training data is unreliable, confidence is the enemy. You want the model to be cautious and flag uncertainty.

**Better**: State the task context neutrally:
```
Task: Write SQL queries against a D365FO 10.0 Azure SQL database.
```

---

## Part 3: Prompt Templates

### 3.1 SQL Extraction Prompt (No DB Access)

```
Task: Write SQL queries against a D365FO 10.0 Azure SQL database
(AxDB export copy) for legal entity '{ENTITY}', filtered to
calendar year {YEAR}:

{List of data domains needed}

Critical instructions — follow exactly:

STEP 1 - For each query, list the tables and state the FULL composite
primary key / relation key between header and line tables. Explain how
you know the join is complete (not partial). If uncertain, say so.

STEP 2 - For every column, mark confidence:
  [CERTAIN] = very sure this is the D365FO 10.0 SQL name
  [CHECK]   = may differ from AX2012 or vary by version
List known AX2012-to-D365FO renames relevant to these tables.

STEP 3 - Specific requirements:
- GeneralJournalEntry is cross-company (no DATAAREAID). Use the correct
  field for legal entity filtering.
- InventTrans has no DIRECTION field. Derive it from QTY sign.
- GeneralJournalAccountEntry uses ISCREDIT (not ISDEBIT).
- DimensionAttributeValueCombination may have a direct MAINACCOUNT FK —
  check before building a 4-table dimension chain.
- LedgerJournalTrans has no stored MST amount fields and no POSTED field
  (POSTED is on LedgerJournalTable).

STEP 4 - Write the final SQL with:
- WITH (NOLOCK) hints on all tables
- Sargable date filters (>= and <, not YEAR())
- @LegalEntity variable
- Comments next to any [CHECK] columns
```

### 3.2 SQL Extraction Prompt (With DB Access)

```
Task: Write SQL queries against this D365FO database:
Server={server};Database={database};User Id={user};Password={pass};

Extract for legal entity '{ENTITY}', calendar year {YEAR}:
{List of data domains needed}

Method — follow exactly:

1. For each table you plan to use, first run:
   SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_NAME='{TABLE}' ORDER BY ORDINAL_POSITION
   to get the actual column names. Do NOT guess from memory.

2. For header-to-line table joins, verify the complete composite key.
   D365FO invoice tables typically use 4-5 field composite keys.

3. Build each query and validate with TOP 5 before delivering.

4. For GeneralJournalEntry: this table has no DATAAREAID column
   (cross-company). Verify the correct company filter field from
   the column list.

5. Deliver final queries with WITH (NOLOCK) hints and @LegalEntity
   variables.
```

### 3.3 X++ Code Analysis Prompt

```
Task: Analyze the X++ code for {CLASS/TABLE/FORM} in D365FO.

Context:
- D365FO version: 10.0.{VERSION}
- PackagesLocalDirectory: {PATH}
- Model: {MODEL_NAME}

Instructions:
1. Read the XML metadata file from AxClass/{ClassName}.xml
2. Identify the class hierarchy (extends, implements)
3. Map all parm* methods (builder pattern)
4. Identify hookable methods and extension points
5. Trace the call chain for {specific method}

Output format:
- Class hierarchy diagram
- Key method signatures with parameters
- Extension points available for customization
- Dependencies on other classes/tables
```

### 3.4 Data Migration Analysis Prompt

```
Task: Design a data migration from {SOURCE} to D365FO.

Source: {description of source system/tables}
Target: D365FO legal entity '{ENTITY}'

Instructions:
1. Map source fields to D365FO target fields
2. For each target table, specify:
   - The FULL composite key (all fields)
   - Required fields vs optional
   - Foreign key dependencies (which tables must be loaded first)
3. Identify data transformations needed
4. Note any cross-company considerations
5. Specify the load order (dependency sequence)

D365FO-specific rules:
- InventDim records must exist before InventTrans
- EcoResProduct must exist before InventTable (released products)
- NumberSequence must be configured before any document creation
- DATAAREAID must match the target legal entity exactly (lowercase)
```

---

## Part 4: Skill File References for Context Injection

When prompting an LLM for D365FO tasks, inject the relevant skill file content to ground the model's knowledge. This dramatically reduces hallucination.

### 4.1 Skill Injection Pattern

```
I'm providing you with a verified reference document for D365FO SQL
queries. Use ONLY the table structures, field names, and join keys
from this reference. Do not add columns that are not listed here.

{Paste content of d365fo-sql-direct-queries.md}

Now write a query to: {your specific task}
```

### 4.2 Which Skill to Inject

| Task Type | Skill File | Why |
|-----------|-----------|-----|
| SQL extraction queries | `d365fo-sql-direct-queries.md` | Verified field names, join keys, enum values |
| X++ code analysis | `d365fo-analysis.md` | Class hierarchies, patterns, ECM module |
| X++ development | `d365fo-development.md` | CoC extensions, event handlers |
| Security analysis | `d365fo-security-analysis.md` | Role/duty/privilege model, SoD |
| Lasernet reports | `lasernet.md` | Report design, D365FO integration |
| Excel data files | `powershell-excel-ooxml.md` | OOXML manipulation, ImportExcel |
| Vendor invoice integration | `basware-d365-vendor-invoice-integration.md` | Payload shapes, posting pipeline, known defects |

### 4.3 Multi-Skill Injection

For complex tasks spanning multiple domains, inject multiple skills:

```
I'm providing verified reference documents for this task.

=== D365FO SQL Reference ===
{d365fo-sql-direct-queries.md - relevant sections only}

=== Basware Vendor Invoice Integration ===
{basware-d365-vendor-invoice-integration.md - relevant sections only}

Task: Write the SQL that reconciles imported invoice totals against
the posted voucher for the flagged invoices.
```

---

## Part 5: Validation Checklist

After receiving LLM-generated D365FO SQL, check these items:

### 5.1 Column Name Validation
- [ ] No AX2012 legacy names (CustAccount, PaymTermId, PurchOrderFormNum)
- [ ] No fabricated fields (Direction, SubledgerVoucherType, IsDebit, AmountCurDebMST)
- [ ] CustInvoiceTrans uses SALESUNIT (not Unit)
- [ ] VendInvoiceTrans uses PURCHUNIT (not Unit) and NAME (not ProductName)

### 5.2 Join Completeness
- [ ] CustInvoiceTrans join has 4 fields (SalesId + InvoiceId + InvoiceDate + NumberSequenceGroup)
- [ ] VendInvoiceTrans join has 5 fields (PurchId + InvoiceId + InvoiceDate + NumberSequenceGroup + InternalInvoiceId)
- [ ] InventTrans → InventTransOrigin uses RECID (not natural key)
- [ ] GeneralJournalAccountEntry → GeneralJournalEntry uses RECID

### 5.3 Cross-Company Tables
- [ ] GeneralJournalEntry filtered by SUBLEDGERVOUCHERDATAAREAID (not DATAAREAID)
- [ ] No PARTITION subqueries

### 5.4 Logic Correctness
- [ ] IsCredit (not IsDebit): 1=Credit, 0=Debit
- [ ] InventTrans financially posted: StatusIssue=1 OR StatusReceipt=1
- [ ] Date filters are sargable (>= and <, not YEAR())
- [ ] DATAAREAID values are lowercase

### 5.5 Performance
- [ ] WITH (NOLOCK) on large tables
- [ ] No non-sargable functions on indexed date columns

---

## Part 6: Common Anti-Patterns

### 6.1 "Senior Consultant" Persona
**Bad**: "You are a senior D365FO consultant with 20 years of AX experience"
**Problem**: Increases confidence, not accuracy. LLM will guess more boldly.
**Better**: State the task neutrally and add verification steps.

### 6.2 "Quick and Simple" Request
**Bad**: "Give me a quick SQL to extract customer invoices from D365"
**Problem**: Encourages shortcuts — model will skip join validation, use remembered (possibly wrong) names.
**Better**: Ask for the complete composite key and flag any uncertain columns.

### 6.3 Multiple Domains in One Request
**Bad**: "Write SQL for customer invoices, vendor invoices, GL entries, and inventory transactions"
**Problem**: Breadth over depth. Model spreads attention thin, makes more errors per query.
**Better**: Ask for one domain at a time with full verification, or provide the skill file reference to ground all four.

### 6.4 Trusting Formatting Over Content
**Bad**: Accepting well-formatted SQL with markdown tables and "Key Notes" without checking field names.
**Problem**: LLMs excel at producing professional-looking output that contains factual errors. The more polished the formatting, the harder errors are to spot.
**Better**: Always cross-reference against the validation checklist in Part 5.

### 6.5 AX2012 Contamination Through Terminology
**Bad**: Using AX2012 terminology in the prompt (e.g., "CustAccount", "PaymTermId")
**Problem**: Reinforces the model's AX2012 training data associations.
**Better**: Use D365FO terminology or be version-explicit: "D365FO 10.0 field names only, not AX2012."

---

## Part 7: Model-Specific Notes

### 7.1 Claude (Sonnet / Opus)

**Strengths**:
- Good at following multi-step instructions
- Responds well to confidence-marking instructions ([CERTAIN]/[CHECK])
- Will flag uncertainty when explicitly asked to

**Weaknesses**:
- Defaults to AX2012 names when not constrained
- Tends to over-engineer dimension decode chains
- Will fabricate plausible-sounding fields (SubledgerVoucherType, Direction)

**Best approach**: Use the STEP 1-4 pattern from Template 3.1. Claude follows sequential instructions well.

### 7.2 General Tips (All Models)

- **Inject skill files** as context — this is the single highest-impact improvement
- **Ask for reasoning before code** — models make fewer errors when explaining first
- **Use negative instructions** — "do NOT use..." closes specific failure modes
- **Validate one query at a time** — easier to catch errors than in a batch of four
- **Provide the connection string** if available — self-validation eliminates most errors

---

*Skill based on empirical validation of LLM-generated D365FO SQL (February 2026).*
*Last updated: February 23, 2026*


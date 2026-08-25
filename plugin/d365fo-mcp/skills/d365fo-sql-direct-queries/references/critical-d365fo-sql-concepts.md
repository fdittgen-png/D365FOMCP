# Part 1: Critical D365FO SQL Concepts

_Reference for the `d365fo-sql-direct-queries` skill. Read on demand._


### 1.1 Company Filtering — Two Patterns

D365FO tables fall into two categories:

| Pattern | Property | Filter Method | Example Tables |
|---------|----------|---------------|----------------|
| **Per-company** | `SaveDataPerCompany = Yes` | `WHERE DATAAREAID = 'spno'` | CustInvoiceJour, VendInvoiceJour, InventTrans, LedgerJournalTrans |
| **Cross-company (shared)** | `SaveDataPerCompany = No` | `WHERE SUBLEDGERVOUCHERDATAAREAID = 'spno'` or via LEDGER FK | GeneralJournalEntry, GeneralJournalAccountEntry |

**CRITICAL**: GeneralJournalEntry has NO `DATAAREAID` column. Using `WHERE GJE.DATAAREAID = ...` will cause a runtime error. Use `SUBLEDGERVOUCHERDATAAREAID` instead.

**Do NOT use PARTITION subqueries** — they are fragile and not the intended design pattern.

### 1.2 DATAAREAID Values Are Lowercase

In D365FO SQL, DATAAREAID values are stored in **lowercase** (e.g., `'spno'`, not `'SPNO'`). However, `SUBLEDGERVOUCHERDATAAREAID` on GeneralJournalEntry may contain mixed case. Use case-insensitive comparison or check actual data.

### 1.3 RecId-Based Foreign Keys

Many D365FO relationships use `RecId` (BIGINT) as foreign keys rather than natural keys. Key examples:
- `InventTrans.INVENTTRANSORIGIN` → `InventTransOrigin.RECID`
- `GeneralJournalAccountEntry.GENERALJOURNALENTRY` → `GeneralJournalEntry.RECID`
- `DimensionAttributeValueCombination.MAINACCOUNT` → `MainAccount.RECID`

### 1.4 Enum Values in SQL

D365FO enums are stored as integers in SQL. Key enum mappings:

**StatusIssue** (InventTrans.STATUSISSUE):
| Value | Meaning |
|:-----:|---------|
| 0 | None |
| 1 | Sold (financially posted) |
| 2 | Deducted |
| 3 | Picked |
| 4 | ReservOrdered |
| 5 | ReservPhysical |
| 6 | OnOrder (QuotationIssue) |

**StatusReceipt** (InventTrans.STATUSRECEIPT):
| Value | Meaning |
|:-----:|---------|
| 0 | None |
| 1 | Purchased (financially posted) |
| 2 | Received |
| 3 | Registered |
| 4 | Ordered (Quotation) |
| 5 | Arrived |

**LedgerJournalType** (LedgerJournalTable.JOURNALTYPE):
| Value | Meaning |
|:-----:|---------|
| 0 | Daily |
| 1 | Allocation |
| 5 | VendInvoiceRegister |
| 9 | Payment |

**IsCredit** (GeneralJournalAccountEntry.ISCREDIT):
| Value | Meaning |
|:-----:|---------|
| 0 | Debit |
| 1 | Credit |

**IMPORTANT**: The field is `ISCREDIT`, NOT `ISDEBIT`. There is no IsDebit field. The logic is inverted from what many developers assume.

### 1.5 SQL Is Read-Only on Cloud PROD — Writes Go Through the App

Direct SQL against D365FO is for **investigation and reporting only**. You can write (`UPDATE`/`INSERT`/`DELETE`) against a **database copy** (SUPPORT/PPROD restored DB, BYOD) but **NOT against cloud PRODUCTION** — Microsoft does not expose the PROD AxDB for writes, and direct PROD data edits are unsupported even where technically reachable.

**Consequence for data-fix tickets:** a SQL `UPDATE` that "fixes" a record on the SUPPORT copy proves the fix but does **not** reach PROD. The PROD correction must be applied through a supported channel:
- **In-app UI action** (preferred when one exists) — e.g. clearing a stuck `MCROrderStopped` ("Do not process") flag by adding a dummy order hold and removing it, which makes the order-events engine recompute the flag.
- **Deployed X++ runnable class / SysOperation job** that uses `select forUpdate … update()` — runs inside the app with proper validation and business logic.
- **DMF / data entity import** for bulk master-data corrections.

**Workflow:** validate the fix on the SUPPORT copy with SQL → translate it into a UI action or X++ job → apply to PROD that way. Never present a raw PROD `UPDATE` as the deliverable. (Reading PROD via the d365kb/SQL tooling is fine; this environment's egress is also firewall-blocked from the support DB — see memory `reference_support_db_firewall_block`.)


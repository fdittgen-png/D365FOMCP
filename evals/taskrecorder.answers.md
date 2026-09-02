# Task Recorder evals — verified answers and the calls that produce them

Verified 2026-09-02 through `src/local/mcp-server-taskrecorder.js`. The service has no
database; both fixtures are checked in, so this set is stable by construction:

- **A** = `test/fixtures/taskrec-sample.axtr` (3,371 B) — recording "test", canonical id
  `1becf689-…`, 2 actions (1 command RequestClose on form SysAADClientTable, 1 navigation to
  menu item DefaultDashboard), BPM data source `SysAADClientTable` → 1 table, 9 BPM role rows
  (3 × SysAADClientTableMaintain Full control, 6 × TOC_ReadOnlyPrivilege View).
- **B** = `test/fixtures/test.axtr` (4,103 B) — recording "test", canonical id `bbb26ccc-…`,
  2 actions (ExecuteHyperlink on control `ElectronicMessagesGrid_MessageStatus_StatusId`,
  MarkActiveRow on grid `ElectronicMessagesGrid`) on form ElectronicMessagesForm, BPM data
  sources 5 tables, 25 BPM role rows over 4 privileges (TOC_ReadOnlyPrivilege,
  ElectronicMessageView, ElectronicMessageMaintain ×4 Full control, ElectronicMessageOperate ×1
  Full control).

Every pair makes the same two calls — `taskrecorder_to_markdown {file_content:<base64 of A>,
file_name:"taskrec-sample.axtr"}` and the same for B (`@b64:` placeholders in
`taskrecorder.calls.json`) — and derives the answer from the returned `markdown`.
`structuredContent` is 3,011 B + 6,762 B = **9,773 B** per pair.

| # | Title | Derivation from the markdown | Answer |
|---|---|---|---|
| 1 | Total user actions | `**Total User Actions** \| 2` in both | **4** |
| 2 | Form in B not in A | "Forms Visited" tables: A `SysAADClientTable`, B `ElectronicMessagesForm` | **ElectronicMessagesForm** |
| 3 | The navigating recording and its menu item | only A has `**Navigate:**`; `**Menu Item:** \`DefaultDashboard\`` | **taskrec-sample.axtr,DefaultDashboard** |
| 4 | Data-source tables B − A | "Data Sources" rows: B 5 backticked tables, A 1 | **4** |
| 5 | Null-control file + other file's hyperlink control | A has `**Control:** null`; B's ExecuteHyperlink step: `[ElectronicMessagesGrid_MessageStatus_StatusId]` | **taskrec-sample.axtr,ElectronicMessagesGrid_MessageStatus_StatusId** |
| 6 | Distinct command action types | `**Action:** Command (X)`: A RequestClose; B ExecuteHyperlink, MarkActiveRow | **ExecuteHyperlink,MarkActiveRow,RequestClose** |
| 7 | Distinct privileges, both BPM tables | 3rd column of the "Security Roles" tables: SysAADClientTableMaintain, TOC_ReadOnlyPrivilege, ElectronicMessageView, ElectronicMessageMaintain, ElectronicMessageOperate | **5** |
| 8 | Full-control privilege in A, Full-control rows in B | A: SysAADClientTableMaintain (3 rows); B: 4 ElectronicMessageMaintain + 1 ElectronicMessageOperate | **SysAADClientTableMaintain,5** |
| 9 | Same name? same canonical ID? | both "test"; ids differ | **True,False** |
| 10 | The one list/grid-context step | only B: `### Step 2 … **List/Grid Context:** ElectronicMessagesGrid` | **test.axtr,2,ElectronicMessagesGrid** |

Notes

- `taskrecorder_to_document {…, return_inline:true, include_users:false}` **writes**
  `%TEMP%\test.mhtml` even when asked to return inline (12,430 B `structuredContent`, 9.1 KB
  file). It is therefore not used by a read-only eval; if a document question is wanted later,
  give it an `output_path` inside the scratch directory and treat it as a write.
- The role names in the BPM tables are security roles (some custom, some as bare GUIDs), not
  people; no user is ever named. The markdown footer carries a generation timestamp, which no
  expression reads.
- The mcp-builder LLM harness passes only the question text to the model; these questions
  name the fixture paths so a harness with file access (or a pre-loaded base64) can answer them.
  See `evals/README.md`.

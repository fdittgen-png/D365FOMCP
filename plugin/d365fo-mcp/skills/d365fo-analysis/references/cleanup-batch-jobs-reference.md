# Part 18: Cleanup Batch Jobs Reference

_Reference for the `d365fo-analysis` skill. Read on demand._


### 18.1 High-Impact Cleanup Classes

| Class | Target Table(s) | Default Retention | Risk Level |
|-------|-----------------|-------------------|------------|
| `SysDeletedObjects365Cleanup` | SysDeletedObjects365 | 30 days | Low |
| `DMFStagingDataCleanup` | DMF*Staging tables | 7 days | Medium |
| `DocuCleanup` | DocuRef, DocuValue | 90 days | High |
| `BatchJobCleanup` | BatchJob, BatchJobHistory | 30 days | Low |
| `SysTracesCleanup` | SysTraces* | 7 days | Low |
| `RetailTransactionCleanup` | RetailTransaction* | Company policy | High |
| `LedgerJournalCleanup` | LedgerJournal* | Year-end | Critical |

### 18.2 DocuValue and Attachment Cleanup

**Tables:**
- `DocuRef`: Document references (metadata)
- `DocuValue`: Actual file content or reference

**Key Fields:**
- `DocuValue.FileSize`: Logical file size in bytes
- `DocuValue.StorageProviderId`: Where file is stored
- `DocuRef.TypeId`: Document type classification

**Cleanup Considerations:**
1. Check attachments before deleting
2. Archive to SharePoint if needed
3. Test in non-PROD first
4. Consider legal retention requirements

### 18.3 GL Archive Feature

**Prerequisites:**
1. Year-end close must be completed
2. Fiscal year must be closed
3. All journals posted

**Process:**
1. General Ledger > Periodic > Archive ledger transactions
2. Select closed fiscal years
3. Archive moves to separate archive tables
4. Reports still available via archive queries


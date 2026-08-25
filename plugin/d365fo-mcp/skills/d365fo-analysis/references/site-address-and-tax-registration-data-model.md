# Part 23: Site Address and Tax Registration Data Model

_Reference for the `d365fo-analysis` skill. Read on demand._


### 23.1 Overview

For retrieving site postal addresses and VAT registration numbers (e.g., for Packing Slips, Invoices, Delivery Notes), use the following data model.

**Key Finding (January 2026):**
Site-level TaxRegistration via DirPartyLocation is **currently NOT configured** in most databases. The query design supports both site-specific and company-level VAT using COALESCE for automatic fallback.

### 23.2 Key Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `INVENTSITE` | Site master data | RECID, SITEID, NAME, DATAAREAID |
| `INVENTSITELOGISTICSLOCATION` | Links site to location | SITE (FK), LOCATION (FK), ISPRIMARY |
| `LOGISTICSLOCATION` | Location master | RECID |
| `LOGISTICSPOSTALADDRESS` | Postal addresses | LOCATION, STREET, CITY, ZIPCODE, STATE, COUNTRYREGIONID, ADDRESS, VALIDFROM, VALIDTO |
| `DIRPARTYTABLE` | Party/Legal entity | DATAAREA, VATNUM, COREGNUM |
| `DIRPARTYLOCATION` | Party-Location link | RECID, PARTY, LOCATION |
| `TAXREGISTRATION` | Tax registration | DIRPARTYLOCATION (FK), REGISTRATIONNUMBER |

### 23.3 Entity Relationships

```
INVENTSITE
    │
    ├── DATAAREAID ─────────────────────────────────────┐
    │                                                    │
    └── RECID                                            ▼
         │                                    DIRPARTYTABLE
         ▼                                    (DATAAREA = INVENTSITE.DATAAREAID)
INVENTSITELOGISTICSLOCATION                        ├── VATNUM
(SITE = INVENTSITE.RECID, ISPRIMARY = 1)          └── COREGNUM
         │
         ▼
LOGISTICSLOCATION (RECID = sll.LOCATION)
         │
         ├─────────────────────────────────┐
         ▼                                 ▼
LOGISTICSPOSTALADDRESS             DIRPARTYLOCATION
(LOCATION = ..., VALIDFROM/TO)     (currently NOT populated for sites)
         │                                 │
         ├── STREET                        ▼
         ├── CITY                    TAXREGISTRATION
         ├── ZIPCODE                 (would return site VAT if configured)
         ├── STATE
         ├── COUNTRYREGIONID
         └── ADDRESS
```

### 23.4 SQL Query - Site Address + VAT Registration

```sql
-- Get site address with VAT/Registration numbers
-- Site-specific values override company values when configured (via COALESCE)
SELECT
    s.DATAAREAID,
    s.SITEID,
    s.NAME AS SiteName,
    pa.STREET,
    pa.ZIPCODE,
    pa.CITY,
    pa.STATE,
    pa.COUNTRYREGIONID,
    pa.ADDRESS AS FullAddress,

    -- Site-specific values (from TaxRegistration if configured)
    tr.REGISTRATIONNUMBER AS SiteSpecificVAT,

    -- Company-level values (from DirPartyTable)
    dp.VATNUM AS CompanyVATNum,
    dp.COREGNUM AS CompanyRegNum,

    -- Consolidated values (site overwrites company if defined)
    COALESCE(tr.REGISTRATIONNUMBER, dp.VATNUM) AS EffectiveVATNum,
    COALESCE(tr.REGISTRATIONNUMBER, dp.COREGNUM) AS EffectiveRegNum,
    COALESCE(tr.REGISTRATIONNUMBER, dp.VATNUM, dp.COREGNUM) AS EffectiveTaxNumber

FROM INVENTSITE s
LEFT JOIN INVENTSITELOGISTICSLOCATION sll
    ON sll.SITE = s.RECID AND sll.ISPRIMARY = 1
LEFT JOIN LOGISTICSLOCATION l
    ON l.RECID = sll.LOCATION
LEFT JOIN LOGISTICSPOSTALADDRESS pa
    ON pa.LOCATION = l.RECID
    AND GETDATE() BETWEEN pa.VALIDFROM AND pa.VALIDTO
LEFT JOIN DIRPARTYLOCATION dpl
    ON dpl.LOCATION = l.RECID
LEFT JOIN TAXREGISTRATION tr
    ON tr.DIRPARTYLOCATION = dpl.RECID
LEFT JOIN DIRPARTYTABLE dp
    ON dp.DATAAREA = s.DATAAREAID
ORDER BY s.DATAAREAID, s.SITEID;
```

### 23.5 VAT Resolution Priority (COALESCE)

| Priority | Source | Description | Current State |
|----------|--------|-------------|---------------|
| 1 | `tr.REGISTRATIONNUMBER` | Site-specific TaxRegistration | Not configured (NULL) - can be enabled |
| 2 | `dp.VATNUM` | Company VAT number | Used when available |
| 3 | `dp.COREGNUM` | Company registration number | Fallback when VATNUM is NULL |

**Design Principle:** Site-specific values override company values when configured. This supports scenarios where a site in a different country requires a different VAT number than the legal entity.

### 23.6 Why Site-Level TaxRegistration Currently Returns NULL

1. `INVENTSITELOGISTICSLOCATION` records exist for many sites
2. `LOGISTICSLOCATION` records are properly linked
3. **HOWEVER:** `DIRPARTYLOCATION` records do NOT exist where `LOCATION = LogisticsLocation.RECID`
4. Without `DIRPARTYLOCATION`, the join to `TAXREGISTRATION` fails (returns NULL)

### 23.7 How to Enable Site-Specific VAT

If site-specific VAT registration is needed:
1. Create a `DirPartyLocation` record linking the site's `LogisticsLocation` to a party
2. Create a `TaxRegistration` record linked to that `DirPartyLocation`
3. The COALESCE query will automatically use the site-specific value

### 23.8 Important Notes

- **Always include validity check** for postal addresses: `GETDATE() BETWEEN pa.VALIDFROM AND pa.VALIDTO`
- **Primary location only:** Filter on `ISPRIMARY = 1` for site locations
- **Company-level fallback:** Use `DIRPARTYTABLE.DATAAREA = INVENTSITE.DATAAREAID` for company VAT


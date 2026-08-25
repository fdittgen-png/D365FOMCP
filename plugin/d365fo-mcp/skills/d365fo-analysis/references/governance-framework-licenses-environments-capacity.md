# Part 17: Governance Framework - Licenses, Environments & Capacity

_Reference for the `d365fo-analysis` skill. Read on demand._


### 17.1 License Types and Pricing (December 2025)

| License Type | Price | Use Case | Key Limitations |
|--------------|-------|----------|-----------------|
| **Base (Full User)** | $210/user/month | Finance OR SCM app access | Minimum 20 licenses of one app required |
| **Attach** | $30/user/month | Second app for Base user | Requires existing Base license |
| **Combined (Finance + SCM)** | $240/user/month | Both Finance and SCM | Most common for full users |
| **Team Member** | $8/user/month | Read-only + basic approvals | Limited transactional access |
| **Activity (Operations)** | $50/user/month | Transactional workers | No financial posting, no production orders |
| **Device** | $75-85/device/month | Shared warehouse/POS terminals | NOT tracked in PPAC reports |
| **Premium (SCM)** | $300/user/month | Advanced planning, AI features | Copilot capabilities |

> **Note:** Pricing increased October 2024 from $180 to $210 for Base licenses.

### 17.2 License Optimization Matrix

| User Profile | Current License | Recommended | Monthly Savings |
|--------------|-----------------|-------------|-----------------|
| Executive (dashboards only) | Finance Base | Team Member | $202/user |
| Approver (PO/Expense approvals) | Finance Base | Team Member | $202/user |
| Warehouse worker | SCM Base | Activity | $160/user |
| Shop floor operator | SCM Base | Activity | $160/user |
| Customer service (lookups) | Finance Base | Team Member | $202/user |

### 17.3 License Compliance Timeline

| Date | Event | Action Required |
|------|-------|-----------------|
| **September 1, 2025** | Warning banners displayed | Review PPAC reports |
| **January 15, 2026** | Enforcement begins (staged) | Ensure compliance before contract anniversary |
| **Contract Anniversary** | Validation for tenant | Users without valid licenses blocked |

**System Administrator Exception:** System Admin role is exempt from licensing requirements.

### 17.4 Environment Tiers

| Tier | Purpose | Hosting | Database | Cost | Characteristics |
|------|---------|---------|----------|------|-----------------|
| **Tier 1** | Development, Build | Cloud-Hosted (Customer Azure) | SQL Server | ~$500/month | Single-box, hourly billing, NOT for perf testing |
| **Tier 2** | UAT (Standard Acceptance Test) | Microsoft Managed | Azure SQL | ~$1,400/month | Multi-box, simulates PROD architecture |
| **Tier 3** | Enhanced UAT | Microsoft Managed | Azure SQL | ~$4,000/month | Higher performance for larger data |
| **Tier 4** | Performance Testing | Microsoft Managed | Azure SQL | ~$8,000/month | Temporary, pre-Go-Live validation |
| **Tier 5** | Full Performance Testing | Microsoft Managed | Azure SQL | ~$12,000/month | PROD-equivalent, major rollouts |
| **PROD** | Live Operations | Microsoft Managed | Azure SQL | Included | HA + DR included |

> **Note:** Tier 1 environments are no longer Microsoft-hosted since November 2020. They must be deployed on customer Azure subscription.

### 17.5 Standard vs Add-On Environments

| Environment Type | Included in License | Notes |
|------------------|---------------------|-------|
| Production | ✅ Yes | Sized by Subscription Estimator |
| Tier 2 UAT | ✅ Yes (1x) | Standard acceptance testing |
| Additional Tier 2+ | ❌ Add-on purchase | Performance testing, training |
| Tier 1 Dev/Build | ❌ Customer Azure | Billed to customer subscription |

### 17.6 Golden Configuration Best Practices

| Practice | Description |
|----------|-------------|
| **Maintain Golden Environment** | Keep pristine configuration separate from testing |
| **Use Tier 2 for Golden** | Enables LCS self-service database refresh |
| **Never Refresh Gold from PROD** | Always refresh FROM Gold TO UAT/Dev |
| **Generic Admin Account** | Use a generic ERP service account (e.g. erp-batch) for batch jobs (survives employee turnover) |
| **Document All Changes** | Track config changes made during testing |

**Data Flow:**
```
GOLDEN → DEV
GOLDEN → UAT → PROD
⚠️ NEVER: PROD → GOLDEN (corrupts baseline)
```

### 17.7 LCS Subscription Estimator

| Aspect | Details |
|--------|---------|
| **Purpose** | Size production environment based on workload |
| **Input** | Transaction lines per hour, user count |
| **Tier 2 Benchmark** | ~30-40 users OR 3,000 transaction lines/hour |
| **Requirement** | Mandatory before PROD deployment |
| **Revisit Frequency** | Annually or before major changes |

**Path:** `LCS > Implementation Project > Subscription Estimator`

### 17.8 PPAC Navigation

#### License Consumption Report
```
Power Platform Admin Center
└── Licensing (left menu)
    └── User License Consumption
        └── Finance and Operations (tab)
            ├── Total Users
            ├── Licensed Users
            ├── Underlicensed Users ← ACTION REQUIRED
            ├── Overlicensed Users ← OPTIMIZATION OPPORTUNITY
            └── Export to CSV
```

#### Capacity Monitoring
```
Power Platform Admin Center
└── Resources
    └── Capacity
        ├── Database usage
        ├── File storage
        ├── Log storage
        └── Per-environment breakdown
```

### 17.9 Capacity Storage Types

| Storage Type | Description | Cost Profile | Optimization |
|--------------|-------------|--------------|--------------|
| **Database** | Relational data (tables, indexes) | Expensive (~$40/GB/month) | Archive closed years, cleanup routines |
| **File** | Attachments, PDFs, images | Moderate | Move to SharePoint/Azure Blob |
| **Log** | Audit logs, trace logs, DMF | Moderate | Retention policies, purge old logs |

### 17.10 IDMF Clarification

> **❌ CRITICAL:** IDMF (Intelligent Data Management Framework) is for **AX2012 ONLY** and is NOT available for D365FO.

**D365FO Alternatives:**
1. **Cleanup Batch Jobs**: 63+ built-in cleanup routines
2. **GL Archive**: Year-end close then archive closed years
3. **BYOD Export**: Move historical data to external storage
4. **Custom Cleanup Jobs**: X++ batch jobs for specific tables

### 17.11 Four-Phase Governance Cycle

```
       ┌─────────────┐
       │   ANALYZE   │  Security role audit, user activity,
       │ (Discovery) │  environment sizing, capacity profiling
       └──────┬──────┘
              │
    ┌─────────┴─────────┐
    ▼                   ▼
┌─────────┐       ┌─────────┐
│OPTIMIZE │       │ MANAGE  │  Golden config, environment lifecycle,
│(Cleanup)│◄─────►│  (Ops)  │  user provisioning, batch governance
└────┬────┘       └────┬────┘
     │                 │
     └────────┬────────┘
              ▼
       ┌─────────────┐
       │   REPORT    │  License consumption, capacity usage,
       │(Visibility) │  environment health, cost allocation
       └─────────────┘
```

### 17.12 User Activity Aging Report

**Path:** `System Administration > Security > Security Governance > User Activity Aging`

**Configuration:** `System Administration > Security > Security Governance Setup > Parameters > User Aging Periods`

**Default Aging Buckets:** 30 / 60 / 90 / 120+ days

**Best Practice:** Disable users inactive >90 days, quarterly recertification.

### 17.13 Key Security Reports

**Path:** `System Administration > Inquiries > Security`

| Report | Purpose |
|--------|---------|
| User role assignments | Current user-role mappings |
| Security role access | Effective permissions per role |
| Security duty assignments | Duties within roles (SoD analysis) |

### 17.14 License-Related Tools

| Tool | Location | Purpose |
|------|----------|---------|
| PPAC License Report | Power Platform Admin Center | Source of truth for compliance |
| User Security Governance | D365FO System Admin | Role-to-license mapping |
| License Usage Summary | D365FO System Admin | Internal license view (deprecated) |
| Assign Roles Dialog | Users form | Shows license impact when assigning roles |

### 17.15 Governance KPIs

| Metric | Target | Measurement |
|--------|--------|-------------|
| License utilization rate | >85% | PPAC report |
| Inactive license % | <5% | User Activity Aging |
| Database capacity usage | <80% | PPAC Capacity |
| Environment provisioning time | <24 hours | LCS tracking |
| Cost optimization savings | >10% annually | Azure Cost Management |

### 17.16 Environment Lifecycle Classification

| Class | Policy | Auto-Actions | Examples |
|-------|--------|--------------|----------|
| **Strategic** | Always on, full support | None | PROD, UAT |
| **Project** | Time-boxed (3-6 months) | Alert at 80% lifecycle | Implementation DEV |
| **Experimental** | Auto-delete after 30-60 days | Mandatory expiry tag | POC, Spike |
| **Training** | Seasonal, on-demand | Scale down when idle | Training environments |

### 17.17 BYOD Capacity Monitoring

For detailed table-level capacity monitoring, use BYOD (Bring Your Own Database):

**Custom Tables:**
- `MyDbCapacityLog`: Table name, record count, estimated size, snapshot date
- `MyBlobCapacityLog`: Document type, file count, total size, legal entity

**Key SQL for Physical Size in BYOD:**
```sql
SELECT t.name AS TableName, p.rows AS RowCount,
    CAST(SUM(a.total_pages) * 8.0 / 1024 AS DECIMAL(18,2)) AS TotalSizeMB
FROM sys.tables t
INNER JOIN sys.indexes i ON t.object_id = i.object_id
INNER JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
INNER JOIN sys.allocation_units a ON p.partition_id = a.container_id
WHERE t.is_ms_shipped = 0 AND i.index_id <= 1
GROUP BY t.name, p.rows
ORDER BY TotalSizeMB DESC;
```

**See Section 0.13 of the strategy document for full implementation details.**


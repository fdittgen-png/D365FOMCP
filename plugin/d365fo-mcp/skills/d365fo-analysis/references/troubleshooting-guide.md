# Part 10: Troubleshooting Guide

_Reference for the `d365fo-analysis` skill. Read on demand._


### 10.1 Common Issues

| Issue | Possible Cause | Solution |
|-------|----------------|----------|
| Product not found after creation | Transaction not committed | Check ttsbegin/ttscommit |
| ItemId differs from ProductNumber | Number sequence configured | Check number sequence setup |
| Release fails to target company | Validation error | Check release policy rules |
| Variant creation fails | Master not released | Release master first |
| Intercompany release error | Circular release | Cannot release to engineering org |

### 10.2 Diagnostic Queries

```x++
// Find all items for a product
select ItemId, DataAreaId from InventTable
    where InventTable.Product == productRecId;

// Find all released versions
select crosscompany * from EngChgReleasedProductVersion
    where EngChgReleasedProductVersion.EngineeringProductVersion == versionRecId;

// Check release history
select * from EngChgProductRelease
    where EngChgProductRelease.Product == productRecId;
```


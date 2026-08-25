# Part 6: Cross-Company Operations

_Reference for the `d365fo-analysis` skill. Read on demand._


### 6.1 changecompany Pattern

```x++
// Switch to target company for operations
changecompany (targetCompanyId)
{
    ttsbegin;

    // All operations here execute in targetCompanyId context
    InventTable inventTable;
    inventTable.ItemId = itemId;
    inventTable.Product = productRecId;
    inventTable.insert();

    ttscommit;
}
// Returns to original company context automatically
```

### 6.2 crosscompany Queries

```x++
// Query across all companies
while select crosscompany DataAreaId, ItemId from inventTable
    where inventTable.Product == productRecId
{
    // Process each company's item
}
```

### 6.3 Validation: Prevent Circular Release

```x++
private boolean validateNotReleasingInEngineeringCompany()
{
    EngChgEngineeringOrganization engOrg = EngChgEngineeringOrganization::findByKey(
        this.engChgProductVersion().EngineeringOrganizationId
    );

    if (this.ReleasingCompanyId == engOrg.legalEntityId()
        && this.ReleasingCompanyId == this.DataAreaId)
    {
        return checkFailed("@ENG:Error_CannotReleaseEngineeringProductInEngineeringLegalEntity");
    }

    return true;
}
```


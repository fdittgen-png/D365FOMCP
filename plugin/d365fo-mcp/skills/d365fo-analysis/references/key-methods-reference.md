# Part 8: Key Methods Reference

_Reference for the `d365fo-analysis` skill. Read on demand._


### 8.1 Product Creation

| Method | Class | Purpose |
|--------|-------|---------|
| createProduct() | EngChgEcoResProductCreate | Main product creation |
| createDistinctProductVariant() | EngChgEcoResProductCreate | Create variant from master |
| createEngineeringProduct() | EngChgEcoResProductCreate | Static entry point |
| initFromParmsProduct() | EngChgEcoResProductCreate | Initialize product fields |

### 8.2 Product Release

| Method | Class | Purpose |
|--------|-------|---------|
| release() | EngChgEcoResProductReleaseManager | Main release workflow |
| createInventTable() | EngChgEcoResProductReleaseManager | Create inventory item |
| populateInventDistinctProduct() | EngChgEcoResProductReleaseManager | Link item to product |
| run() | EngChgEcmProductReleaseCollect | Collect release targets |
| run() | EngChgEcmProductReleaseProcess | Process ECO releases |

### 8.3 Version Management

| Method | Class | Purpose |
|--------|-------|---------|
| find() | EngChgProductVersion | Static finder |
| getReleasedProductVersion() | EngChgProductVersion | Get released version |
| initFromEcoResProduct() | EngChgReleasedProductVersion | Initialize from product |

### 8.4 Static Finders

```x++
// Common finder patterns
EcoResProduct::find(RecId _recId)
EcoResProductIdentifier::findByProductNumber(ProductNumber _productNumber)
InventTable::findByProduct(RecId _productRecId)
EngChgProductVersion::find(RecId _recId, boolean _update = false)
```


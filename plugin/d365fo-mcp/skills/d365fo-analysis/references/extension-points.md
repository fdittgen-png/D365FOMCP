# Part 11: Extension Points

_Reference for the `d365fo-analysis` skill. Read on demand._


### 11.1 Hookable Methods (Can Extend)

- `EngChgEcoResProductReleaseManager.createProductPerCompanyTables()`
- Various validation methods

### 11.2 Non-Hookable Methods (Core Logic)

- `EngChgEcoResProductReleaseManager.createInventTable()`
- Core release logic

### 11.3 Event Subscriptions

```x++
// Subscribe to product creation events
[SubscribesTo(classStr(EngChgEcoResProductCreate), delegateStr(EngChgEcoResProductCreate, productCreated))]
public static void onProductCreated(EcoResProduct _product)
{
    // Custom logic
}
```


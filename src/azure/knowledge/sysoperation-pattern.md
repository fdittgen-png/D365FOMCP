---
topic: sysoperation-pattern
title: SysOperation framework — controller, service, contract, UI builder
aliases: sysoperation, batch-job, runbase-replacement, data-contract
tags: x++, batch, pattern, sysoperation
---
- **Data contract** — `[DataContractAttribute] class MyContract` with `[DataMemberAttribute('Name')] public Type parmName(Type _v = name)` methods; optional `[SysOperationLabel]`, `[SysOperationHelpText]`, `[SysOperationDisplayOrder]`, `[SysOperationGroup]`. Contracts must be serialisable: primitives, EDTs, enums, `List` via `[AifCollectionTypeAttribute]`, `date`/`utcdatetime`, `container` for query packs (`[AifQueryTypeAttribute]`).
- **Service** — `class MyService extends SysOperationServiceBase` with `public void process(MyContract _contract)` doing the work. Business logic lives here, not in the controller; make it callable from code and tests.
- **Controller** — `class MyController extends SysOperationServiceController`; `main(Args _args)` constructs it with `classStr(MyService), methodStr(MyService, process), SysOperationExecutionMode::Synchronous|ScheduledBatch|ReliableAsynchronous` and calls `startOperation()`. Override `caption()`, and `canGoBatchJournal()` for batch-enabled controllers; `parmShowDialog(false)` for silent runs.
- **UI builder** (optional) — `class MyUIBuilder extends SysOperationAutomaticUIBuilder`, bound with `[SysOperationContractProcessing(classStr(MyUIBuilder))]` on the contract; override `postBuild()` to register lookups / `postRun()` for dynamics.
- **Menu item** — an Action menu item with `ObjectType = Class`, `Object = MyController`; a privilege grants it. The KB lists Action menu items in `menu_items`; `sec_object_access` shows which roles reach it.
- **Batch** — the contract is packed per batch task; keep it small and side-effect free. Long-running work: `SysOperationExecutionMode::ReliableAsynchronous` runs on the batch server without a batch job definition.
- Classic `RunBaseBatch` still exists but new work should use SysOperation; `d365_find_method_implementations('process')` with `owner_type: 'class'` and a `modules` filter lists existing services to model on.

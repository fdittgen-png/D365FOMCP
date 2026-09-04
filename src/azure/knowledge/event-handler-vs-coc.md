---
topic: event-handler-vs-coc
title: Event handlers vs. Chain of Command — which to use
aliases: event-handlers, pre-post-handlers, delegates, subscriber
tags: extensibility, x++, events, coc, design
sources: https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/extensibility/method-wrapping-coc, https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/extensibility/extensibility-attributes
---
**Chain of Command** — wrap the method, run code before and/or after `next`, read and change arguments and the return value, access protected members, keep state in the extension class. Use it when you need the return value, need to alter arguments, need protected state, or need to run inside the same transaction scope in a controlled order relative to the original body. Requires the method to be wrappable (see `extensibility-attributes`).

**Pre/Post event handlers** — `[PreHandlerFor(classStr(X), methodStr(X, m))]` / `[PostHandlerFor(...)]` static methods receiving `XppPrePostArgs`. No `next`, no access to protected members, arguments/return value only through `XppPrePostArgs` (`getArg`, `getReturnValue`, `setReturnValue`). Use when the method is hookable but not wrappable, or when you only need a side effect and want zero coupling to the method body.

**Delegates** — `[SubscribesTo(classStr(X), delegateStr(X, d))]` on a static method with the delegate's signature. The base code decides WHERE it raises the delegate; you cannot add new delegates to Microsoft code. Prefer a delegate over CoC when one exists for your purpose — it is the author's supported extension point and survives refactoring better.

**Form events** — data source / control events via `[FormDataSourceEventHandler]`, `[FormControlEventHandler]`, `[FormEventHandler]` with `FormDataSourceEventType` / `FormControlEventType` / `FormEventType`; or CoC on the nested concept (`formDataSourceStr`, `formControlStr`) when you need `next`.

**Rule of thumb.** Delegate if one exists → CoC if the method is wrappable and you need arguments/return/protected state → pre/post handler for side effects only. Never rely on execution order between extensions from different models.

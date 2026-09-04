---
topic: coc-rules
title: Chain of Command (CoC) — wrapping rules
aliases: chain-of-command, coc, method-wrapping, next-call
tags: extensibility, x++, coc, next
sources: https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/extensibility/method-wrapping-coc, https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/extensibility/extensibility-attributes
---
**Shape.** `[ExtensionOf(classStr(Target))] final class Target_Extension { ... }` — the extension class is `final`, the wrapper has the SAME name and signature as the wrapped method, and calls `next <method>(<args>)` to continue the chain. Tables use `tableStr(...)`, forms `formStr(...)`, data entities `tableStr(...)`; form-nested concepts use `formDataSourceStr`, `formDataFieldStr`, `formControlStr` — one extension class per nested concept.

**What can be wrapped.** Public and protected methods of classes, tables, data entities and forms (root-level form methods only). Static methods of classes (declare the wrapper `static`; not on forms — form statics have no semantics). `protected internal` since Platform update 25. Wrapping a base-class method in an extension of a DERIVED class applies only to instances of that derived class.

**What cannot.** `private` methods. `internal` methods. Methods marked `[Hookable(false)]`. Methods marked `[Wrappable(false)]`. `final` methods unless the author added `[Wrappable(true)]`. Constructors (`new`) — a `new` on an extension class is the extension's own constructor and must be public with no arguments. Purely X++ methods on form-nested types compile but the wrapper is not invoked at runtime.

**The `next` call is mandatory and unconditional.** Exactly one `next` on a first-level statement of the body: not inside `if`, not in `while`/`do-while`/`for`, no `return` before it, not inside a logical expression. `try/catch/finally` around `next` is allowed (Platform update 21+). Only methods marked `[Replaceable]` may skip `next`, and the expectation is still to break the chain conditionally, not always.

**Default parameters.** The wrapper signature must NOT repeat the default value: `public void salute(str message)` wraps `public void salute(str message = "Hi")`.

**Access.** From the extension class you can read protected fields and call protected methods of the augmented class (Platform update 9+).

**Order.** When several models wrap the same method the runtime order is undefined — never depend on running before or after another extension.

**Preflight here.** `d365_preflight(object_name, method_name)` parses the stored signature and returns `coc_wrappable` + the reason; `xref_find_extensions` / `d365_preflight.existing_extensions` list wrappers that already exist.

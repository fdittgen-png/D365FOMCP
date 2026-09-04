---
topic: extension-limits
title: What cannot be extended — and what to do instead
aliases: sealed, final-class, internal, not-extensible, overlayering
tags: extensibility, limits, coc, design
sources: https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/extensibility/method-wrapping-coc, https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/extensibility/extensibility-attributes
---
Overlayering is gone: every change to Microsoft or ISV code is an extension, and these are the hard limits.

- **Private and internal members** — not wrappable, not hookable (private can be made hookable only by its author). Request an extension point (Microsoft extensibility request) or re-implement the calling method.
- **`[Hookable(false)]` / `[Wrappable(false)]` methods and `final` methods without `[Wrappable(true)]`** — no CoC. Pre/post handlers still work on hookable ones.
- **Constructors** — cannot be wrapped; use a delegate or a factory method if the author exposes one.
- **Form-nested X++ methods** — CoC on data-source/control methods works for the system methods (`init`, `validateWrite`, `clicked`…); purely X++ methods declared on nested types are not invoked when wrapped.
- **Static form methods** — no semantics, cannot be wrapped.
- **Macros** — `#define` values are compiled into the caller; changing one does nothing for already-compiled code and macro files cannot be extended. Prefer constants on a class you own.
- **Sealed ISV models (binary only)** — 17 of 19 non-Microsoft models on the dev box ship no X++ source. The KB knows their element inventory, CoC wrappers, event handlers and (with the IL scan) method SIGNATURES, never bodies: `d365_isv_lookup`, `d365_isv_extension_points`, `xref_isv_find_usages`. A signature tells you the contract, not the behaviour.
- **Kernel / system classes** (`FormRun`, `xRecord`, `Global` intrinsics) — only their hookable X++ surface is extensible.
- **Data entities** — extend via `AxDataEntityViewExtension` (fields, data sources) and CoC on entity methods (`validateWrite`, `mapEntityToDataSource`, `postLoad`); computed fields need the base entity's compute method to be wrappable.
- **Execution order between extensions** — undefined; never rely on it.

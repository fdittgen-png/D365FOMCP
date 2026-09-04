---
topic: common-compiler-errors
title: Common X++ compiler / best-practice errors around extensions, and the fix
aliases: compiler-errors, build-errors, bp-errors, best-practice
tags: x++, compiler, errors, coc, best-practice
sources: https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/extensibility/method-wrapping-coc
---
Wording is paraphrased; match on the concept, not the exact string.

- **"The method must call `next` … exactly once / unconditionally"** — the `next` call sits inside an `if`, a loop, a logical expression, or after a `return`. Move it to a first-level statement (`try/catch/finally` is allowed). If the method is `[Replaceable]` the rule does not apply.
- **"Method … is not wrappable / cannot be augmented"** — the target is `private`, `internal`, `final` without `[Wrappable(true)]`, or `[Hookable(false)]`/`[Wrappable(false)]`. Use a pre/post handler if it is hookable, a delegate if one exists, or ask for an extension point. `d365_preflight` reports the reason.
- **"Wrapper signature does not match"** — default parameter values were repeated in the wrapper, or a parameter type differs. Copy the signature without defaults.
- **"An extension class must be final"** — add `final` to the `[ExtensionOf]` class.
- **"Constructor cannot be extended" / `new` with arguments on an extension class** — extension `new` must be public and parameterless; constructors of the augmented class are not wrappable.
- **"Control … violates pattern …" (form pattern errors)** — the added control is not an allowed child of the patterned container. Inspect the container with `d365_lookup_form(include_controls: true)` and pick an allowed parent, or wrap the new control in an allowed group.
- **"Object … does not exist" for a field or method that exists on the environment** — the build snapshot is behind the environment (runtime `*_Custom` fields, or a newer model). `d365_check_field_exists` checks both; the response banner gives the snapshot date.
- **BP: "Name does not start with the model prefix" / naming violations** — enforce with `d365_preflight(proposed_names)` and `KB_NAMING_PREFIXES`.
- **BP: "Label not found / literal string should be a label"** — see `label-id-rules`; use your own label file and `literalStr`.
- **Duplicate extension name** — two models augment the same object with an extension class of the same name; suffix the class with your model prefix (`CustTable_ABC_Extension`).

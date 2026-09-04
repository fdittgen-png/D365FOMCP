---
topic: extensibility-attributes
title: Hookable, Wrappable, Replaceable — what each attribute permits
aliases: hookable, wrappable, replaceable, attributes
tags: extensibility, x++, coc, events
sources: https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/extensibility/extensibility-attributes
---
| Modifier | Hookable (pre/post events) | Wrappable (CoC) | Signature |
|---|---|---|---|
| `private` | No (`[Hookable(true)]` opts in) | No — cannot opt in | may change |
| `internal` | No | No | may change |
| `protected` | No (`[Hookable(true)]` opts in) | Yes, unless `final` | must stay compatible |
| `protected internal` | No | Yes, from Platform update 25 | must stay compatible |
| `public` | Yes (`[Hookable(false)]` opts out) | Yes, unless `final` | must stay compatible |

- `[Hookable(false)]` disables BOTH pre/post handlers AND Chain of Command (compatibility rule). `[Hookable(true)]` only enables pre/post handlers — it does not make a method wrappable.
- `[Wrappable(false)]` on a public/protected method forbids CoC. `[Wrappable(true)]` on a `final` public/protected method allows it. There is no opt-in for private methods.
- `[Replaceable]` marks a method whose wrappers are not forced to call `next`; extenders may break the chain, ideally conditionally.
- A hookable method costs extra IL; authors of performance-critical methods mark them `[Hookable(false)]`.
- Best practice for authors: if others may call but must not change your method, mark it `final` and consider `[Wrappable(false)]` / `[Hookable(false)]`.

The KB stores the attribute block as part of `methods.signature` (e.g. `[Hookable(false)] internal static boolean exist(...)`); `d365_preflight` reads it from there.

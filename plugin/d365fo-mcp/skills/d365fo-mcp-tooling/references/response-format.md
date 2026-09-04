# Response-format contract — what every tool returns

_Reference for the `d365fo-mcp-tooling` skill._

Every tool now declares an `outputSchema` and returns a typed payload via `structuredResult(typed, fallbackText)`. The MCP SDK validates that payload on **both** ends (server on send, client on receive), and the two ends differ — which created two distinct `-32602` bugs:

- **Success responses must always carry `structuredContent`** matching the schema, *including zero-row results*. The empty path calls `emptyResult(context, typedEmptyPayload)` with empty arrays / zeroed counts / known scalars — a bare `emptyResult(context)` throws `-32602 "… has an output schema but no structured content was provided"` (server-side). A static-scan test enforces the 2nd argument.
- **Error responses must carry NO `structuredContent`.** The SDK *client* validates `structuredContent` against the schema even when `isError` is true, so an `{error:{…}}` payload fails for every schema'd tool (`-32602 "Structured content does not match…"`). `errorResult` / `notFoundResult` / `patternErrorResult` / `timeoutErrorResult` are **text + `isError` only**; diagnostics go in the text channel.

Other hard-won rules:
- **`@SYS` labels**: resolve via `makeLabelResolver(db)`; the labels table column is **`text`** (not `label_text`). A wrong column makes the resolver silently pass-through and leak raw IDs.
- **Text channel format**: typed `structuredContent` stays **JSON** (it's what the SDK validates and what the claude.ai connector bills); the text channel is **adaptive** — per response the server emits TOON or Markdown, whichever is smaller (TOON wins on nested payloads, Markdown on wide flat tables). `format: "markdown"` / `"toon"` pin it; the default is the right choice unless the text is quoted verbatim.
- **Banner and coverage lines** (2026-09-02): line 2 of every snapshot-backed data response is `_<Service> snapshot: <YYYY-MM-DD>_`; beneath it, one italic line per coverage signal that applies — `field_limit_hit`, `provenance_omitted`, `isv_not_scanned`, `isv_excluded` (exact count), `partial_build` — each mirrored by an optional typed key. Meta-responses (`emptyResult` / `notFoundResult` / `errorResult`, marked `_meta.kind`) carry neither.
- **Pagination**: list tools return `has_more` always and `next_cursor` only when `has_more` is true; pass it back as `cursor` (opaque, stateless) with unchanged arguments. `total_count` appears only when cheap.
- **Not-found responses list the closest existing names** for the requested kind; batch tools return misses in `not_found[]` and are a success, not an error.
- **Loop guard**: the third identical call (tool + arguments) within fifteen calls returns a short corrective note with no `structuredContent` — a meta-response, not a failure.

---

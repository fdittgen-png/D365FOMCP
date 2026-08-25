# Response-format contract — what every tool returns

_Reference for the `d365fo-mcp-tooling` skill._

Every tool now declares an `outputSchema` and returns a typed payload via `structuredResult(typed, fallbackText)`. The MCP SDK validates that payload on **both** ends (server on send, client on receive), and the two ends differ — which created two distinct `-32602` bugs:

- **Success responses must always carry `structuredContent`** matching the schema, *including zero-row results*. The empty path calls `emptyResult(context, typedEmptyPayload)` with empty arrays / zeroed counts / known scalars — a bare `emptyResult(context)` throws `-32602 "… has an output schema but no structured content was provided"` (server-side). A static-scan test enforces the 2nd argument.
- **Error responses must carry NO `structuredContent`.** The SDK *client* validates `structuredContent` against the schema even when `isError` is true, so an `{error:{…}}` payload fails for every schema'd tool (`-32602 "Structured content does not match…"`). `errorResult` / `notFoundResult` / `patternErrorResult` / `timeoutErrorResult` are **text + `isError` only**; diagnostics go in the text channel.

Other hard-won rules:
- **`@SYS` labels**: resolve via `makeLabelResolver(db)`; the labels table column is **`text`** (not `label_text`). A wrong column makes the resolver silently pass-through and leak raw IDs.
- **Text channel format**: typed `structuredContent` stays **JSON** (it's what the SDK validates); the human/LLM text channel uses **TOON** as the default on flat-uniform-table tools (`*_raw_sql`, search, list) and Markdown for nested/detail tools. 

---

# Operations: D365FO MCP Services

**Project**: tis-p-mcpd365fo
**Owner**: Trelleborg IT Services (TIS)
**Status**: Current

Operational runbook complementing [Administration.md](Administration.md). This document captures runtime concerns — limits, quotas, monitoring thresholds — that operators need at hand when triaging incidents.

---

## 1. Upload size limits

### 1.1 Global Functions limit (`host.json`)

`host.json` declares `"maxRequestBodySize": 2147483648` (2 GB) globally. This is **intentional** and sized for the security database upload endpoint, which receives full DMF / AOT export ZIPs that can exceed 1 GB. The KB and XRef rebuild paths are server-side (build scripts → blob storage), not HTTP uploads.

Azure Functions does **not** support per-route body-size overrides in `host.json`. Tighter caps must be enforced inside the handler itself.

### 1.2 Per-endpoint overrides

| Endpoint | Limit | Enforced where |
|----------|-------|----------------|
| `POST /api/d365sec/upload` | 200 MB | `MAX_UPLOAD_BYTES` constant in `src/functions/d365sec-upload.js`; checked against `file.size` after multipart parse |
| `POST /api/d365taskrecorder/upload` | **10 MB** | `MAX_UPLOAD_BYTES` constant in `src/functions/d365taskrecorder.js`; **Content-Length pre-checked before the body is read into memory** (issue #43) |
| MCP JSON-RPC endpoints (`d365kb`, `d365xref`, `d365sec`, `d365taskrecorder` GET/POST without `/upload`) | inherits 2 GB global | (separate hardening tracked in issue #29) |

### 1.3 Sizing rationale

- Task Recorder recordings (`.axtr`) are XML-based screen captures, normally well under 1 MB. The 10 MB cap is generous enough to absorb pathological recordings but cheap enough to reject runaway uploads early.
- Security DB upload accepts the full DMF export ZIP — these legitimately reach hundreds of MB.

### 1.4 Hardening pattern

For any new upload endpoint, prefer the **Content-Length pre-check** pattern from `d365taskrecorder.js`:

```js
const sizeRejection = checkUploadSize(request.headers.get('content-length'));
if (sizeRejection) return sizeRejection;
// only now read the body
```

Reading the body first (`await request.formData()` / `await request.arrayBuffer()`) and checking size afterwards defeats the purpose — Azure Functions has already buffered the entire payload by then.

---

## 2. Related documentation

| Document | Description |
|----------|-------------|
| [Administration](Administration.md) | Build, deploy, maintenance procedures |
| [Architecture](Architecture.md) | System design, security model, data flow |
| [Implementation](Implementation.md) | Build pipeline, schemas, tool catalog |

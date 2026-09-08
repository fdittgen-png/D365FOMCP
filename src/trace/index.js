/**
 * ERP trace module — public surface. `src/azure/*` imports ONLY from here
 * (static scan in test/trace-contract.test.js); `src/trace/*` imports from
 * `src/azure/` only in `client/identity.js` (shared.js, server-metadata.js).
 */
export { CONTRACT_VERSION, IDENTIFIER_RE, isIdentifier, makeId, ulid, investigationId, requestKey } from './contract/identifiers.js';
export { partyDataViolation, proseViolation, maskDigitRuns, termViolation } from './contract/privacy.js';
export { applyArgPolicies, policyFor, sqlShape, payloadRef, touchedFromArgs, parseToolName, POLICIES, TOUCHED_KINDS } from './contract/arg-policies.js';
export { matchEntities, parseDeclaredEntities } from './contract/vocabulary-match.js';
export { sanitize, isSanitized, SANITIZED, PROSE_CAPS } from './contract/sanitize.js';
export { envelope, callRecord, claudeRecord, sessionKey, hourToken } from './contract/record.js';
export { validateRecord, traceValidator, traceSchema, SCHEMA_PATH } from './contract/validate.js';
export { argTypes, argPolicies } from './client/zod-arg-types.js';
export { traceIdentity } from './client/identity.js';
export { TraceWriter, fileSink, httpSink, memorySink, nullSink, traceWriter, traceEnabled, resetTraceWriter, identityTokenProvider } from './client/writer.js';
export { withTrace, resultSummary, currentInvestigation, currentInvestigationPath } from './client/with-trace.js';

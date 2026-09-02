/**
 * PM-04 — Central registry of Zod output schemas for MCP tools.
 *
 * Every schema here mirrors the `structuredContent` shape a handler emits
 * via `structuredResult(structured, fallbackText)`. The SDK validates both
 * sides (server on send, client on receive) — a shape mismatch throws
 * `InvalidParams` on both ends. Keep these schemas strict but be willing
 * to loosen individual fields during rollout if the underlying data has
 * unexpected nullability.
 *
 * Import pattern in the tool file:
 *   import { d365LookupTableOutput } from './output-schemas.js';
 *   ...
 *   server.registerTool('d365_lookup_table', {
 *     annotations: READ_ONLY_DB_ANNOTATIONS,
 *     description: '...',
 *     inputSchema: { table_name: z.string() },
 *     outputSchema: d365LookupTableOutput.shape,   // pass raw shape, not the wrapper
 *   }, handler);
 *
 * See `memory/architecture_brief_mcp_sdk_v1_27.md` §2 for the SDK's
 * strict-validation behavior.
 */

import { z } from 'zod';

// ── NO `.meta({ id })` in this file (W1, #105 — tried, measured, reverted) ───
// Zod 4's toJSONSchema (which the SDK calls with no options) extracts a schema
// registered with `.meta({ id })` into `definitions` and `$ref`s it, so a row
// shape used in both the single and the batch branch of a tool would ship once
// instead of twice: measured −3,244 B across the four servers (13 shapes).
// It is NOT safe: Zod copies the `id` INTO the definition, and AJV — the SDK
// client's structuredContent validator — throws `NOT SUPPORTED: keyword "id"`
// at compile time, so every callTool on such a tool fails on an SDK client.
// tool-sets.js strips it from the wire for the entry points, but a McpServer
// that registers `registerKbTools()` directly (the integration harness, any
// library user) is not hooked and would break. A 1.8% saving that turns a bare
// registration into a client-breaking server is the wrong trade; the budget
// test compiles the UNHOOKED registration path with the SDK's AJV so a future
// `.meta({ id })` fails there, not in a client. Re-open only with a hook the
// register functions themselves install, or an SDK option to pass `reused`.

// ── Shared: coverage-boundary keys (#116, Q3) ────────────────────────────────
// Emitted by `coverageNotes()` in shared.js and merged into the typed payload by
// `structuredResult(..., { coverage })` ONLY when the signal fires (rule #14) —
// hence `.optional()`, never `.nullable()`. A tool spreads the subset it can
// fire; `partial_build` is on every KB data tool because the delta-merge path
// (#86) affects the whole KB, not one tool.
export const coverageKeys = Object.freeze({
  partial_build: z.boolean().optional(),
  field_limit_hit: z.boolean().optional(),
  provenance_omitted: z.number().optional(),
  isv_not_scanned: z.boolean().optional(),
  isv_excluded: z.number().optional(),
});
/** Pick a subset of `coverageKeys` to spread into an output schema. */
export const coverage = (...names) => Object.fromEntries(names.map(n => [n, coverageKeys[n]]));
const kbCoverage = coverage('partial_build');

// ── Shared: model build provenance row ───────────────────────────────────────
// One scanned model's descriptor data (model_versions table). Shared by
// d365_get_module_summary, sec_stats, and the list-modules tools. All fields
// except model_name are nullable — a descriptor may omit any of them, and
// databases built before provenance capture have no rows at all.
export const modelVersionRowSchema = z.object({
  model_name: z.string(),
  module_id: z.string().nullish(),
  display_name: z.string().nullish(),
  publisher: z.string().nullish(),
  layer: z.string().nullish(),
  origin: z.string().nullish(),   // 'microsoft' | 'isv' | 'custom' | 'unknown'
  version: z.string().nullish(),  // VersionMajor.Minor.Build.Revision
});

// ── Issue #87/#90: UI custom fields, read live from an environment ───────────
//
// Naming note: `d365LookupTableOutput.custom_field_count` already means
// "fields added by an AxTableExtension" — a build-time customisation. These are
// a different animal: fields created through System administration > Setup >
// Custom fields, which live in a runtime table extension and appear in NO
// build snapshot. They are therefore called `ui_custom_fields` wherever both
// concepts can appear in one payload.

/** One configured environment, secret-free (`secret_name` is a NAME). */
export const d365CustomFieldSourceSchema = z.object({
  environment: z.string(),
  title: z.string(),
  url: z.string(),
  is_default: z.boolean(),
  origin: z.string().nullish().describe('Where the registry entry came from: app setting, config file, or env.'),
  cached: z.boolean(),
  cached_property_count: z.number().nullish(),
  fetched_at: z.string().nullish(),
  cache_expires_in_seconds: z.number().nullish(),
  last_error: z.string().nullish(),
});

/** One custom field as observed in an environment's OData $metadata.
 *
 *  `entity_name` + `property_name` are OBSERVED. `table_name` is DERIVED: the
 *  field is created on a table and propagated to the entities exposing it, so
 *  the entity → table direction is inference, resolved locally against the KB's
 *  data_entities / entity_fields. `attribution` records which it is, and must
 *  never be dropped when rendering. */
export const d365UiCustomFieldSchema = z.object({
  entity_name: z.string(),
  property_name: z.string(),
  type: z.string().nullish(),
  nullable: z.boolean().nullish(),
  max_length: z.number().nullish(),
  table_name: z.string().nullish(),
  attribution: z.enum(['primary-table', 'derived', 'unresolved']),
});

/** The custom-field block attached to a resolved field check. */
export const d365UiCustomFieldMatchSchema = z.object({
  environment: z.string(),
  entity_name: z.string(),
  property_name: z.string(),
  type: z.string().nullish(),
  max_length: z.number().nullish(),
  fetched_at: z.string(),
});

export const d365CustomFieldsOutput = z.object({
  environment: z.string().nullish(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  fetched_at: z.string().nullish(),
  cached: z.boolean().nullish(),
  entity_count: z.number().nullish(),
  property_count: z.number().nullish().describe('Custom properties found in the environment.'),
  shown: z.number().optional().describe('Rows in `fields` after filters and limit.'),
  fields: z.array(d365UiCustomFieldSchema).optional(),
  // Present when the tool is called with no filter, or when no source is
  // configured: "what can I even query" answered in the same call.
  sources: z.array(d365CustomFieldSourceSchema).optional(),
  note: z.string().nullish(),
});

// ── Pilot 1: d365_lookup_table ───────────────────────────────────────────────

export const d365LookupTableFieldSchema = z.object({
  name: z.string(),
  type: z.string().nullish(),
  edt: z.string().nullish(),
  enum_type: z.string().nullish(),
  label: z.string().nullish(),
  mandatory: z.number().nullish(),
  // Customization provenance (false / null on standard Microsoft fields, and
  // on KB databases built before the customization columns existed).
  // OPTIONAL, decided per response (#107.4, rule #14): present on every row
  // with custom_only / include_provenance, absent on every row otherwise —
  // the pair cost +3,714 tk on a 284-field entity while repeating the table's
  // own module. Absent, never null-when-omitted: hence optional, not nullish.
  is_extension: z.boolean().optional(),
  source_module: z.string().nullish(),
});

export const d365LookupTableIndexSchema = z.object({
  name: z.string(),
  is_unique: z.boolean(),
  is_clustered: z.boolean(),
  fields: z.array(z.string()),
});

// One join-field pair, shared by the outgoing and incoming relation rows.
export const joinFieldPairSchema = z.object({
  field: z.string().nullish(),
  related_field: z.string().nullish(),
});

export const d365LookupTableRelationSchema = z.object({
  relation_name: z.string().nullish(),
  related_table: z.string().nullish(),
  join_fields: z.array(joinFieldPairSchema),
  relationship_type: z.string().nullish(),
  on_delete: z.string().nullish(),
});

export const d365LookupTableIncomingRelationSchema = z.object({
  source_table: z.string().nullish(),
  relation_name: z.string().nullish(),
  join_fields: z.array(joinFieldPairSchema),
});

export const d365LookupTableOutput = z.object({
  ...kbCoverage,
  ...coverage('field_limit_hit', 'provenance_omitted', 'isv_not_scanned'),
  table_name: z.string(),
  module_id: z.string().nullish(),
  label: z.string().nullish(),
  table_group: z.string().nullish(),
  save_per_company: z.number().nullish(),
  cache_lookup: z.string().nullish(),
  clustered_index: z.string().nullish(),
  replacement_key: z.string().nullish(),
  field_count: z.number(),
  // fields_matched = rows after the fields_like / custom_only filters (equals
  // field_count when neither is passed); fields_shown = rows in `fields` after
  // field_limit (#107.3); fields_truncated = matched > shown.
  fields_matched: z.number(),
  fields_shown: z.number(),
  fields_truncated: z.boolean(),
  // Customization summary: is_customized=true when an AxTableExtension adds
  // fields; custom_field_count counts them; customization_modules lists the
  // models that contributed them.
  is_customized: z.boolean(),
  custom_field_count: z.number(),
  customization_modules: z.array(z.string()),
  fields: z.array(d365LookupTableFieldSchema),
  indexes: z.array(d365LookupTableIndexSchema),
  outgoing_relations: z.array(d365LookupTableRelationSchema),
  incoming_relations: z.array(d365LookupTableIncomingRelationSchema),
  incoming_relations_truncated: z.boolean(),
  // Issue #90 — present only with include_custom_fields=true. A SEPARATE
  // block: UI custom fields are live environment state and must never be
  // interleaved into `fields`, which means "declared in a scanned model".
  ui_custom_fields: z.array(d365UiCustomFieldSchema).optional(),
  ui_custom_field_environment: z.string().nullish(),
  ui_custom_field_fetched_at: z.string().nullish(),
  ui_custom_field_note: z.string().nullish().describe('Why the live block is absent or partial.'),
});

// ── d365_effective_schema (issue #85) ────────────────────────────────────────
// `origin` / `module` / `model_origin` are on EVERY field row (rule #14: they
// are what distinguishes the rows). The isv_* keys are present together or
// absent together: absent with include_isv=false or on a pre-ISV database.
export const d365EffectiveFieldSchema = z.object({
  name: z.string(),
  type: z.string().nullish(),
  edt: z.string().nullish(),
  enum_type: z.string().nullish(),
  label: z.string().nullish(),
  mandatory: z.number().nullish(),
  origin: z.enum(['base', 'extension']),
  module: z.string().nullish(),
  model_origin: z.string().nullish(),
});
export const d365EffectiveSchemaOutput = z.object({
  ...kbCoverage,
  ...coverage('field_limit_hit', 'isv_not_scanned'),
  table_name: z.string(),
  module_id: z.string().nullish(),
  model_origin: z.string().nullish(),
  label: z.string().nullish(),
  table_group: z.string().nullish(),
  field_count: z.number(),
  base_field_count: z.number(),
  extension_field_count: z.number(),
  fields_shown: z.number(),
  fields_truncated: z.boolean(),
  contributing_models: z.array(z.object({
    module: z.string().nullish(),
    origin: z.enum(['base', 'extension']),
    model_origin: z.string().nullish(),
    field_count: z.number(),
  })),
  fields: z.array(d365EffectiveFieldSchema),
  indexes: z.array(d365LookupTableIndexSchema),
  relations: z.array(d365LookupTableRelationSchema),
  isv_extensions: z.array(z.object({ module: z.string(), extension_name: z.string() })).optional(),
  isv_delete_actions: z.array(z.object({
    module: z.string(), target: z.string().nullish(), relation: z.string().nullish(), action: z.string().nullish(),
  })).optional(),
  isv_provenance: z.lazy(() => isvProvenanceSchema).optional(),
});

// ── Pilot 2: d365_get_class_methods ──────────────────────────────────────────

export const d365ClassMethodSchema = z.object({
  method_name: z.string(),
  signature: z.string().nullish(),
  is_static: z.boolean(),
  // OMITTED entirely on a signature listing (include_source false) rather than
  // emitted as null: measured at 10.7-12.0% of the listing on real classes
  // (2,741 tokens of literal `"source_code":null` on InventMovement's 577
  // methods). Same defect as the include_counts nulling.
  source_code: z.string().nullish(),
  // Body line count, present on a signature listing INSTEAD of the dead null —
  // and cheaper than it was. This is the signal that makes the two-tier pattern
  // a decision rather than a guess: the caller can see that a method is 9 lines
  // or 270 before spending a turn on d365_get_method_source.
  source_lines: z.number().int().optional(),
});

// ── Cursor pagination (issue #109 part A) ────────────────────────────────────
// Spread into the outputSchema of every paginated list tool: `has_more` is
// always present on a single-target response, `next_cursor` only when there is
// a next page (rule #14). `pageShape` is the strict form; `pageShapeOptional`
// is for tools whose batch mode has no page (d365_search, xref_find_references).
export const pageShape = { has_more: z.boolean(), next_cursor: z.string().optional() };
export const pageShapeOptional = { has_more: z.boolean().optional(), next_cursor: z.string().optional() };

export const d365GetClassMethodsOutput = z.object({
  ...kbCoverage,
  owner_name: z.string(),
  owner_type: z.string(),
  extends_class: z.string().nullish(),
  implements_list: z.string().nullish(),
  is_abstract: z.boolean(),
  include_source: z.boolean(),
  method_count: z.number(),
  methods: z.array(d365ClassMethodSchema),
  // Signature listings only: what the whole class would cost at tier 2, so the
  // caller can price `include_source: true` before paying for it.
  source_lines_total: z.number().int().optional(),
  truncated: z.boolean(),
  ...pageShape,
});

// ── Pilot 3: xref_impact_analysis ────────────────────────────────────────────

export const xrefImpactReferencingObjectSchema = z.object({
  source: z.string(),
  kind: z.string(),
  module: z.string().nullish(),
});

export const xrefImpactAnalysisOutput = z.object({
  ...coverage('isv_not_scanned', 'isv_excluded'),
  target_path: z.string(),
  total_refs: z.number(),
  sample_cap: z.number(),
  detail_cap: z.number(),
  sample_truncated: z.boolean(),
  by_kind: z.record(z.string(), z.number()),
  by_module: z.record(z.string(), z.number()),
  referencing_objects: z.array(xrefImpactReferencingObjectSchema),
});

// ── Pilot 4: sec_lookup_user ─────────────────────────────────────────────────
//
// P4-03 / CR-SEC-001 + CR-SEC-004: extends the original PM-05 shape with
// `effective_sub_roles` (transitive role expansion) and `deny_overrides`
// (per-duty Deny rows in the user's effective chain). Both fields are
// always present (possibly empty arrays); count fields are explicit so an
// agent can branch on "0" without re-counting the array.

export const secLookupUserRoleSchema = z.object({
  role_name: z.string(),
  permission_type: z.string().nullish(),
  license_type: z.string().nullish(),
  // P4-08: companies the role is scoped to. Empty array = unrestricted ("(all)").
  companies: z.array(z.string()),
});

export const secLookupUserCompanyRoleSchema = z.object({
  role_name: z.string(),
  company_id: z.string(),
});

export const secLookupUserSubRoleSchema = z.object({
  role_name: z.string(),
  parent_role_name: z.string(),
  permission_type: z.string().nullish(),
});

export const secLookupUserDenyOverrideSchema = z.object({
  role_name: z.string(),
  duty_id: z.string(),
  duty_name: z.string().nullish(),
});

export const secLookupUserOutput = z.object({
  user_id: z.string(),
  person_name: z.string().nullish(),
  email: z.string().nullish(),
  enabled: z.boolean(),
  default_company: z.string().nullish(),
  // true when any of the four lists was cut at `limit`; the *_count keys are exact.
  truncated: z.boolean(),
  role_count: z.number(),
  roles: z.array(secLookupUserRoleSchema),
  company_scoped_role_count: z.number(),
  company_scoped_roles: z.array(secLookupUserCompanyRoleSchema),
  // P4-03 additions
  effective_sub_role_count: z.number(),
  effective_sub_roles: z.array(secLookupUserSubRoleSchema),
  deny_override_count: z.number(),
  deny_overrides: z.array(secLookupUserDenyOverrideSchema),
});

// ── Pilot 5: sec_effective_permissions ──────────────────────────────────────

// grant_* columns are stored as TEXT in the sec DB (values like 'Allow',
// 'Deny', 'Unset', NULL). The schema matches the storage shape so tools
// can pass the values straight through to `structuredContent` without
// converting to booleans or numbers.
export const secEffectivePermissionSchema = z.object({
  object_name: z.string(),
  object_type: z.string().nullish(),
  grant_read: z.string().nullish(),
  grant_create: z.string().nullish(),
  grant_update: z.string().nullish(),
  grant_delete: z.string().nullish(),
  grant_correct: z.string().nullish(),
  grant_invoke: z.string().nullish(),
  duty_perm: z.string().nullish(),
  source: z.string().nullish(),
});

// Deny-wins resolved view: one row per securable object after applying
// Deny-over-Grant per operation. Each effective_* is the net verdict —
// 'Allow', 'Deny', or null (no specification). `status` distinguishes a
// fully-granted object from one that is partly or wholly blocked, which
// maps directly to a UI control being enabled / greyed / hidden.
export const secEffectiveResolvedSchema = z.object({
  object_name: z.string(),
  object_type: z.string().nullish(),
  effective_read: z.string().nullish(),
  effective_create: z.string().nullish(),
  effective_update: z.string().nullish(),
  effective_delete: z.string().nullish(),
  effective_correct: z.string().nullish(),
  effective_invoke: z.string().nullish(),
  status: z.enum(['granted', 'partial', 'denied']),
});

export const secEffectivePermissionsOutput = z.object({
  subject_type: z.enum(['user', 'role']),
  subject_id: z.string(),
  subject_label: z.string(),
  role_count: z.number(),
  object_filter: z.string().nullish(),
  entry_point_count: z.number(),
  truncated: z.boolean(),
  permissions: z.array(secEffectivePermissionSchema),
  // Deny-wins resolved view: one row per object after applying Deny-over-Grant.
  denied_object_count: z.number(),
  effective: z.array(secEffectiveResolvedSchema),
});

// ═════════════════════════════════════════════════════════════════════════════
//  PM-06 rollout — remaining 44 tools
// ═════════════════════════════════════════════════════════════════════════════

// ── KB tools (15) ────────────────────────────────────────────────────────────

// d365_get_join_keys — join relationships between two tables
export const d365GetJoinKeysRelationSchema = z.object({
  source_table: z.string().nullish(),
  related_table: z.string().nullish(),
  relation_name: z.string().nullish(),
  relationship_type: z.string().nullish(),
  join_pairs: z.array(z.object({
    source_field: z.string().nullish(),
    related_field: z.string().nullish(),
  })),
});
export const d365GetJoinKeysTrapSchema = z.object({
  trap_type: z.string(),
  wrong_value: z.string().nullish(),
  correct_value: z.string().nullish(),
  explanation: z.string().nullish(),
});
export const d365GetJoinKeysOutput = z.object({
  ...kbCoverage,
  table1: z.string(),
  table2: z.string(),
  has_relationship: z.boolean(),
  relation_count: z.number(),
  relations: z.array(d365GetJoinKeysRelationSchema),
  trap_count: z.number(),
  traps: z.array(d365GetJoinKeysTrapSchema),
});

// d365_search — full-text search results
export const d365SearchResultSchema = z.object({
  object_type: z.string().nullish(),
  object_name: z.string(),
  module_id: z.string().nullish(),
  context: z.string().nullish(),
});
// Single mode: exactly the pre-batching payload. Batch mode (`queries`, issue
// #83): the shared scope (object_type / modules / limit) is hoisted into the
// envelope and each entry carries only what differs. The two are disjoint.
export const d365SearchQueryPayloadSchema = z.object({
  query: z.string(),
  result_count: z.number(),
  truncated: z.boolean(),
  results: z.array(d365SearchResultSchema),
});
export const d365SearchOutput = z.object({
  ...kbCoverage,
  ...coverage('isv_not_scanned'),
  query: z.string().optional(),
  object_type: z.string().nullish(),
  modules: z.array(z.string()).nullish(),
  limit: z.number(),
  result_count: z.number().optional(),
  truncated: z.boolean().optional(),
  results: z.array(d365SearchResultSchema).optional(),
  ...pageShapeOptional,
  requested_count: z.number().optional().describe('Batch mode only.'),
  queries: z.array(d365SearchQueryPayloadSchema).optional().describe('Batch mode only: one entry per query, caller order.'),
});

// d365_get_enum — enum values
export const d365EnumValueSchema = z.object({
  name: z.string(),
  value: z.number().nullish(),
  // DELIBERATELY an explicit null, not an omission — the one place the
  // omit-dead-keys rule is wrong. 12.3% of enum values carry no label; omitting
  // the key there saves ~1% of the JSON and costs +107% of the TOON text
  // channel, because ragged rows drop TOON out of its tabular form
  // (`values[8]{name,value,label}:` + one line each) into a per-row key/value
  // list. Omit a key only when it is absent from EVERY row of an array.
  label: z.string().nullish(),
});
// One enum's payload. Shared by the single-target fields and the batch array
// so both channels are guaranteed to carry the identical shape.
export const d365EnumPayloadSchema = z.object({
  enum_name: z.string(),
  module_id: z.string().nullish(),
  label: z.string().nullish(),
  value_count: z.number(),
  values: z.array(d365EnumValueSchema),
  // Present ONLY when true. A parse failure has to be visible and must never be
  // silent, but it is the rare case — emitting `"parse_error":false` on every
  // enum spent 171 chars per 9-enum batch saying nothing happened.
  parse_error: z.boolean().optional(),
});

// Batching (issue #83) is a backward-compatible superset, and the two modes are
// disjoint: a single-target call emits *exactly* the payload it emitted before
// batching existed, and a batch call emits only the batch fields. Nothing is
// duplicated across the two channels and a single call pays nothing for the
// feature — measured, after an earlier version that carried both grew the
// response instead of shrinking it.
// W1 (#105): a key the handler OMITS in the other mode is `.optional()`, never
// `.nullish()` — the nullable wrapper is 28 B of `anyOf` per field on every
// tools/list, and it promised a null the handler never emits. Only module_id /
// label can genuinely be null.
export const d365GetEnumOutput = z.object({
  ...kbCoverage,
  enum_name: z.string().optional(),
  module_id: z.string().nullish(),
  label: z.string().nullish(),
  value_count: z.number().optional(),
  values: z.array(d365EnumValueSchema).optional(),
  parse_error: z.boolean().optional(),
  requested_count: z.number().optional().describe('Batch mode only.'),
  resolved_count: z.number().optional(),
  not_found: z.array(z.string()).optional().describe('Batch mode only: names that do not exist.'),
  enums: z.array(d365EnumPayloadSchema).optional().describe('Batch mode only.'),
});

// d365_check_field_exists — per-field existence + note
export const d365CheckFieldResultSchema = z.object({
  field_name: z.string(),
  exists: z.boolean(),
  correct_name: z.string().nullish(),
  note: z.string().nullish(),
  similar: z.array(z.string()),
  // Issue #90 — where the field was found. 'build-metadata' is the scanned
  // snapshot (the historical, implicit meaning of exists=true);
  // 'custom-field' means it was resolved live from a D365 environment because
  // it is a UI custom field and therefore absent from every build snapshot by
  // design. Nullish on databases/clients that predate the distinction.
  origin: z.enum(['build-metadata', 'custom-field']).nullish(),
  custom_field: d365UiCustomFieldMatchSchema.nullish(),
});
// One table's field checks. `found` distinguishes "table does not exist" from
// "table exists and none of these fields do" — collapsing those two into an
// empty check list would be actively misleading when generating SQL.
export const d365CheckFieldTableSchema = z.object({
  table_name: z.string(),
  found: z.boolean(),
  check_count: z.number(),
  checks: z.array(d365CheckFieldResultSchema),
});

// Backward-compatible superset — see d365GetEnumOutput for the pattern.
export const d365CheckFieldExistsOutput = z.object({
  ...kbCoverage,
  table_name: z.string().optional(),
  check_count: z.number().optional(),
  checks: z.array(d365CheckFieldResultSchema).optional(),
  requested_count: z.number().optional().describe('Batch mode only.'),
  not_found: z.array(z.string()).optional().describe('Batch mode only: tables that do not exist.'),
  tables: z.array(d365CheckFieldTableSchema).optional().describe('Batch mode only.'),
});

// d365_get_method_source — single method source
// Backward-compatible superset — see d365GetEnumOutput for the pattern.
// Single-target and batch payloads are disjoint: a single call emits exactly
// the pre-batching shape, a batch call emits only the batch keys.
//
// NOTE the absent owner_type / owner_name: a batch is scoped to ONE owner, so
// those are hoisted to the top level and carried once. Repeating them per entry
// cost 208 chars on a 4-method call and was the entire reason the batch payload
// was bigger than the single calls it replaces.
export const d365MethodSourcePayloadSchema = z.object({
  method_name: z.string(),
  signature: z.string().nullish(),
  is_static: z.boolean(),
  source_code: z.string().nullish(),
  line_count: z.number().int().nullish(),
});
export const d365GetMethodSourceOutput = z.object({
  ...kbCoverage,
  // owner_type is null on a batch whose every method missed; owner_name falls
  // back to the requested name and is never null.
  owner_type: z.string().nullish(),
  owner_name: z.string().optional(),
  method_name: z.string().optional(),
  signature: z.string().nullish(),
  is_static: z.boolean().optional(),
  source_code: z.string().nullish(),
  // Body-relative line count (null when no source). Lets callers cite a line
  // range knowing the upper bound; the rendered Markdown is line-numbered.
  line_count: z.number().int().nullish(),
  requested_count: z.number().optional().describe('Batch mode only.'),
  resolved_count: z.number().optional(),
  not_found: z.array(z.string()).optional().describe('Batch mode only: names not on this owner.'),
  methods: z.array(d365MethodSourcePayloadSchema).optional().describe('Batch mode only.'),
});

// d365_find_referencing_tables — tables referencing this table
export const d365FindReferencingTableSchema = z.object({
  source_table: z.string().nullish(),
  relation_name: z.string().nullish(),
  relationship_type: z.string().nullish(),
  join_fields: z.array(z.object({
    field: z.string().nullish(),
    related_field: z.string().nullish(),
  })),
});
export const d365FindReferencingTablesOutput = z.object({
  ...kbCoverage,
  table_name: z.string(),
  reference_count: z.number(),
  // Rows in `references` after `limit` (#107.6). The handler always emits it on
  // the data path; the schema lacked it and the SDK's AJV (additionalProperties:
  // false) rejected EVERY non-empty response — caught by the eval replay.
  returned_count: z.number().optional(),
  references: z.array(d365FindReferencingTableSchema),
});

// d365_get_module_summary — module stats + key tables/classes
export const d365ModuleKeyTableSchema = z.object({
  table_name: z.string(),
  label: z.string().nullish(),
  field_count: z.number().nullish(),
  save_per_company: z.number().nullish(),
  table_group: z.string().nullish(),
});
export const d365ModuleKeyClassSchema = z.object({
  class_name: z.string(),
  extends_class: z.string().nullish(),
  method_count: z.number().nullish(),
});
export const d365GetModuleSummaryOutput = z.object({
  ...kbCoverage,
  module_id: z.string(),
  // Build provenance of the models in this package (empty on KB databases
  // built before model_versions capture).
  models: z.array(modelVersionRowSchema),
  table_count: z.number(),
  class_count: z.number(),
  enum_count: z.number(),
  entity_count: z.number(),
  form_count: z.number(),
  key_tables: z.array(d365ModuleKeyTableSchema),
  key_classes: z.array(d365ModuleKeyClassSchema),
  tables_truncated: z.boolean(),
  classes_truncated: z.boolean(),
});

// d365_get_entity_sources — data entity + fields
export const d365EntityFieldSchema = z.object({
  field_name: z.string(),
  data_field: z.string().nullish(),
  data_source: z.string().nullish(),
  is_mandatory: z.number().nullish(),
  // Model attribution of the backing table field (null when the entity data
  // source is an alias rather than a table, or on pre-attribution KB builds).
  //
  // OPTIONAL, and omitted by default for fields that are NOT extensions
  // (measured: 262 of 284 fields on EcoResReleasedProductV2Entity carried
  // `"source_module":"ApplicationSuite","is_extension":false`, ~3,400 tokens
  // of payload that says nothing a caller cannot read off the entity's own
  // module). Pass `include_provenance: true` to get the pair on every field.
  // A field that IS an extension always carries both.
  source_module: z.string().nullish(),
  is_extension: z.boolean().nullish(),
});
export const d365GetEntitySourcesOutput = z.object({
  ...kbCoverage,
  ...coverage('provenance_omitted'),
  entity_name: z.string(),
  module_id: z.string().nullish(),
  label: z.string().nullish(),
  public_name: z.string().nullish(),
  public_collection: z.string().nullish(),
  is_public: z.boolean(),
  primary_table: z.string().nullish(),
  staging_table: z.string().nullish(),
  config_key: z.string().nullish(),
  field_count: z.number(),
  // fields_matched = rows after the fields_like / custom_only / computed_only
  // filters; fields_returned = rows actually in entity_fields (after limit).
  fields_matched: z.number(),
  fields_returned: z.number(),
  entity_fields: z.array(d365EntityFieldSchema),
  // Entity-level X++ methods (empty on KB databases built before entity-method
  // extraction was added). Use d365_get_class_methods with include_source for
  // the full X++ body of any method.
  method_count: z.number(),
  methods: z.array(z.object({
    method_name: z.string(),
    signature: z.string().nullish(),
    is_static: z.boolean(),
  })),
  ...pageShape,
});

// d365_sql_template — SQL templates
export const d365SqlTemplateSchema = z.object({
  template_id: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  sql_template: z.string(),
  tables_used: z.string().nullish(),
});
export const d365SqlTemplateOutput = z.object({
  ...kbCoverage,
  scenario: z.string().nullish(),
  template_count: z.number(),
  templates: z.array(d365SqlTemplateSchema),
});

// d365_hallucination_check — trap list
export const d365HallucinationTrapSchema = z.object({
  trap_type: z.string(),
  wrong_value: z.string().nullish(),
  correct_value: z.string().nullish(),
  explanation: z.string().nullish(),
});
export const d365HallucinationCheckOutput = z.object({
  ...kbCoverage,
  table_name: z.string(),
  trap_count: z.number(),
  traps: z.array(d365HallucinationTrapSchema),
});

// d365_raw_sql / xref_raw_sql / sec_raw_sql — raw rows are arbitrary shape.
// We use z.any() because row objects depend on the caller's SELECT clause.
export const rawSqlOutput = z.object({
  row_count: z.number(),
  truncated: z.boolean(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.any())),
});

// d365_graph_traverse — graph walk results
export const d365GraphNodeSchema = z.object({
  node: z.string(),
  node_type: z.string().nullish(),
  edge: z.string().nullish(),
  depth: z.number(),
});
export const d365GraphTraverseOutput = z.object({
  ...kbCoverage,
  start_node: z.string(),
  max_depth: z.number(),
  edge_type: z.string().nullish(),
  node_count: z.number(),
  truncated: z.boolean(),
  nodes: z.array(d365GraphNodeSchema),
});

// d365_field_renames — AX2012 → D365FO pairs
export const d365FieldRenameSchema = z.object({
  ax2012_name: z.string(),
  d365fo_name: z.string(),
});
export const d365FieldRenamesOutput = z.object({
  ...kbCoverage,
  table_name: z.string(),
  rename_count: z.number(),
  renames: z.array(d365FieldRenameSchema),
});

// d365_list_modules — module count + rows
export const d365ModuleRowSchema = z.object({
  module_id: z.string(),
  // OPTIONAL: with `include_counts: false` these keys are OMITTED, not nulled.
  // Nulling them made the payload BIGGER (measured +5.6%): `"table_count":null`
  // is 18 chars against 15 for `"table_count":8`, and most models have small
  // counts. Omission is what makes the option worth having.
  table_count: z.number().nullish(),
  class_count: z.number().nullish(),
  enum_count: z.number().nullish(),
  entity_count: z.number().nullish(),
  form_count: z.number().nullish(),
  // Build provenance (null on KB databases built before model_versions
  // capture). version joins distinct model versions in the package.
  version: z.string().nullish(),
  origin: z.string().nullish(),
  publisher: z.string().nullish(),
  layer: z.string().nullish(),
});
export const d365ListModulesOutput = z.object({
  ...kbCoverage,
  // module_count = modules matching the filter; returned_count = rows in
  // `modules` after `limit`.
  module_count: z.number(),
  returned_count: z.number(),
  modules: z.array(d365ModuleRowSchema),
});

// d365_resolve_label — label resolution result
export const d365ResolvedLabelSchema = z.object({
  label_id: z.string(),
  text: z.string(),
});
export const d365ResolveLabelOutput = z.object({
  ...kbCoverage,
  requested_count: z.number(),
  resolved_count: z.number(),
  not_found_count: z.number(),
  resolved: z.array(d365ResolvedLabelSchema),
  not_found: z.array(z.string()),
});

// ── XRef tools (15) ──────────────────────────────────────────────────────────

// Common: a reference row shared by several xref list tools.
export const xrefRefRowSchema = z.object({
  path: z.string(),
  kind: z.string().nullish(),
  line: z.number().nullish(),
  col: z.number().nullish(),
  module: z.string().nullish(),
});

// xref_find_references
// Sealed-ISV callers (issues #77, #82). Opt-in via `include_isv`, and kept in
// its own block so ISV rows are never interleaved with the main results — the
// two have different fidelity and must stay distinguishable.
export const xrefIsvModuleSummarySchema = z.array(z.object({
  module: z.string(),
  reference_count: z.number(),
}));
// Batch mode (`objects`, issue #83): kind_filter / limit / isv note are hoisted
// into the envelope; each object carries only what differs. Single mode is
// exactly the pre-batching payload. The two are disjoint.
export const xrefFindReferencesObjectSchema = z.object({
  target_path: z.string(),
  result_count: z.number(),
  truncated: z.boolean(),
  references: z.array(xrefRefRowSchema),
  // Present on every object or on none (rule #14), only with include_isv.
  isv: z.object({ reference_count: z.number(), module_summary: xrefIsvModuleSummarySchema }).optional(),
});
export const xrefFindReferencesOutput = z.object({
  ...coverage('isv_not_scanned', 'isv_excluded'),
  target_path: z.string().optional(),
  kind_filter: z.string(),
  limit: z.number(),
  result_count: z.number().optional(),
  truncated: z.boolean().optional(),
  references: z.array(xrefRefRowSchema).optional(),
  isv: z.object({
    reference_count: z.number(),
    module_summary: xrefIsvModuleSummarySchema,
    note: z.string(),
  }).nullish(),
  ...pageShapeOptional,
  requested_count: z.number().optional().describe('Batch mode only.'),
  resolved_count: z.number().optional(),
  not_found: z.array(z.string()).optional().describe('Batch mode only: names that did not resolve.'),
  isv_note: z.string().optional().describe('Batch mode only: the ISV provenance note, carried once.'),
  objects: z.array(xrefFindReferencesObjectSchema).optional().describe('Batch mode only, caller order.'),
});

// xref_find_usages
export const xrefFindUsagesOutput = z.object({
  ...coverage('isv_not_scanned'),
  source_path: z.string(),
  kind_filter: z.string(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  usages: z.array(xrefRefRowSchema),
  ...pageShape,
});

// xref_find_method_callers
export const xrefFindMethodCallersOutput = z.object({
  target_path: z.string(),
  method_name: z.string(),
  owner_name: z.string(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  callers: z.array(z.object({
    path: z.string(),
    line: z.number().nullish(),
    col: z.number().nullish(),
    module: z.string().nullish(),
  })),
});

// xref_class_hierarchy
export const xrefClassHierarchyEntrySchema = z.object({
  path: z.string(),
  class_name: z.string(),
  depth: z.number(),
});
export const xrefClassHierarchyOutput = z.object({
  class_name: z.string(),
  direction: z.enum(['subclasses', 'parents']),
  max_depth: z.number(),
  // result_count = full hierarchy size; returned_count = rows in `entries`.
  result_count: z.number(),
  returned_count: z.number(),
  truncated: z.boolean(),
  entries: z.array(xrefClassHierarchyEntrySchema),
});

// xref_interface_implementors
export const xrefInterfaceImplementorSchema = z.object({
  path: z.string(),
  class_name: z.string(),
  depth: z.number(),
  relationship: z.string(),
});
export const xrefInterfaceImplementorsOutput = z.object({
  interface_name: z.string(),
  interface_path: z.string(),
  // result_count = all implementors; returned_count = rows in `implementors`.
  result_count: z.number(),
  returned_count: z.number(),
  truncated: z.boolean(),
  implementors: z.array(xrefInterfaceImplementorSchema),
});

// xref_search_names
export const xrefSearchNameRowSchema = z.object({
  path: z.string(),
  module: z.string().nullish(),
});
export const xrefSearchNamesOutput = z.object({
  pattern: z.string(),
  object_type: z.string(),
  modules: z.array(z.string()).nullish(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  results: z.array(xrefSearchNameRowSchema),
});

// xref_method_references
export const xrefMethodReferenceRowSchema = z.object({
  path: z.string(),
  kind: z.string().nullish(),
  line: z.number().nullish(),
  col: z.number().nullish(),
});
export const xrefMethodReferencesOutput = z.object({
  source_path: z.string(),
  owner_name: z.string(),
  method_name: z.string(),
  kind_filter: z.string(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  references: z.array(xrefMethodReferenceRowSchema),
});

// xref_module_objects
export const xrefModuleObjectSchema = z.object({
  path: z.string(),
  provider: z.string().nullish(),
});
export const xrefModuleObjectsOutput = z.object({
  module_name: z.string(),
  object_type: z.string(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  objects: z.array(xrefModuleObjectSchema),
});

// xref_cross_module_deps
export const xrefModuleDepRowSchema = z.object({
  module: z.string(),
  ref_count: z.number(),
});
export const xrefCrossModuleDepsOutput = z.object({
  module_name: z.string(),
  direction: z.enum(['depends_on', 'depended_by']),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  modules: z.array(xrefModuleDepRowSchema),
});

// xref_list_modules
export const xrefListModuleRowSchema = z.object({
  module: z.string(),
  object_count: z.number(),
  // Build provenance from Descriptor XMLs (null when the XRef DB was built
  // without XREF_PACKAGES_PATHS / KB_PACKAGES_PATHS, or predates capture).
  version: z.string().nullish(),
  origin: z.string().nullish(),
  publisher: z.string().nullish(),
  layer: z.string().nullish(),
});
export const xrefListModulesOutput = z.object({
  // module_count = modules matching the filter; returned_count = rows in
  // `modules` after `limit`.
  module_count: z.number(),
  returned_count: z.number(),
  modules: z.array(xrefListModuleRowSchema),
});

// xref_object_summary
export const xrefObjectSummaryKindCountSchema = z.object({
  kind: z.string(),
  count: z.number(),
});
export const xrefObjectSummaryPayloadSchema = z.object({
  object_path: z.string(),
  module: z.string().nullish(),
  sub_object_count: z.number(),
  methods: z.array(z.string()),
  incoming_total: z.number(),
  outgoing_total: z.number(),
  incoming_by_kind: z.array(xrefObjectSummaryKindCountSchema),
  outgoing_by_kind: z.array(xrefObjectSummaryKindCountSchema),
});

// Backward-compatible superset — see d365GetEnumOutput for the pattern. This is
// the recommended first call before drilling into an object, so batching it
// removes the most common source of repeated round-trips.
export const xrefObjectSummaryOutput = z.object({
  object_path: z.string().optional(),
  module: z.string().nullish(),
  sub_object_count: z.number().optional(),
  methods: z.array(z.string()).optional(),
  incoming_total: z.number().optional(),
  outgoing_total: z.number().optional(),
  incoming_by_kind: z.array(xrefObjectSummaryKindCountSchema).optional(),
  outgoing_by_kind: z.array(xrefObjectSummaryKindCountSchema).optional(),
  requested_count: z.number().optional().describe('Batch mode only.'),
  not_found: z.array(z.string()).optional().describe('Batch mode only: names that could not be resolved.'),
  objects: z.array(xrefObjectSummaryPayloadSchema).optional().describe('Batch mode only.'),
});

// xref_find_extensions
export const xrefExtensionRowSchema = z.object({
  path: z.string(),
  module: z.string().nullish(),
});
export const xrefFindExtensionsOutput = z.object({
  object_name: z.string(),
  object_type: z.string(),
  limit: z.number(),
  total_count: z.number(),
  truncated: z.boolean(),
  coc_classes: z.array(xrefExtensionRowSchema),
  table_extensions: z.array(xrefExtensionRowSchema),
  form_extensions: z.array(xrefExtensionRowSchema),
  entity_extensions: z.array(xrefExtensionRowSchema),
  other: z.array(xrefExtensionRowSchema),
});

// xref_find_field_usages
export const xrefFieldUsageRowSchema = z.object({
  source: z.string(),
  kind: z.string(),
  line: z.number().nullish(),
  col: z.number().nullish(),
  module: z.string().nullish(),
});
export const xrefFindFieldUsagesOutput = z.object({
  table_name: z.string(),
  field_name: z.string(),
  kind_filter: z.string(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  reads: z.array(xrefFieldUsageRowSchema),
  calls: z.array(xrefFieldUsageRowSchema),
  other: z.array(xrefFieldUsageRowSchema),
});

// xref_find_event_handlers
export const xrefEventHandlerRowSchema = z.object({
  path: z.string(),
  module: z.string().nullish(),
});
export const xrefFindEventHandlersOutput = z.object({
  object_name: z.string(),
  method_name: z.string().nullish(),
  object_path: z.string().nullish(),
  limit: z.number(),
  delegate_methods: z.array(z.string()),
  subscribers: z.array(xrefEventHandlerRowSchema),
  data_event_handlers: z.array(xrefEventHandlerRowSchema),
  overrides: z.array(xrefEventHandlerRowSchema),
  subscribers_truncated: z.boolean(),
  data_event_handlers_truncated: z.boolean(),
  overrides_truncated: z.boolean(),
});

// ── Sec tools (13) ───────────────────────────────────────────────────────────

// sec_lookup_role
export const secLookupRoleSubRoleSchema = z.object({
  role_name: z.string(),
  is_transitive: z.number().nullish(),
});
export const secLookupRoleDutySchema = z.object({
  duty_id: z.string(),
  duty_name: z.string().nullish(),
  permission_type: z.string().nullish(),
});
// A grant column is emitted on every row of a response or on none (rule #14):
// it is omitted only when it is null on EVERY row of that response. Hence
// nullish — present-null must be nullable, absent must be optional.
export const secLookupRoleDirectEntityPermissionSchema = z.object({
  entity_name: z.string(),
  grant_read: z.string().nullish(),
  grant_create: z.string().nullish(),
  grant_update: z.string().nullish(),
  grant_delete: z.string().nullish(),
  grant_correct: z.string().nullish(),
  grant_invoke: z.string().nullish(),
});
// Summary by default (W3 #107.1): each list is capped, and `*_count` holds the
// real total so the array length is never mistaken for it.
export const secLookupRolePayloadSchema = z.object({
  role_id: z.string(),
  role_name: z.string(),
  module_id: z.string().nullish(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  license_type: z.string().nullish(),
  permission_type: z.string().nullish(),
  source: z.string().nullish(),
  sub_roles: z.array(secLookupRoleSubRoleSchema),
  duties: z.array(secLookupRoleDutySchema),
  duty_count: z.number(),
  duties_truncated: z.boolean(),
  direct_privileges: z.array(z.string()),
  direct_privilege_count: z.number(),
  direct_privileges_truncated: z.boolean(),
  direct_entity_permissions: z.array(secLookupRoleDirectEntityPermissionSchema),
  direct_entity_permission_count: z.number(),
  direct_entity_permissions_truncated: z.boolean(),
  assigned_user_count: z.number(),
});
// Single-target: exactly the payload above. Batch (`role_names`, issue #83):
// only the batch keys — the two shapes are disjoint.
export const secLookupRoleOutput = secLookupRolePayloadSchema.partial().extend({
  requested_count: z.number().optional().describe('Batch mode only.'),
  resolved_count: z.number().optional(),
  not_found: z.array(z.string()).optional().describe('Batch mode only: unknown role names.'),
  roles: z.array(secLookupRolePayloadSchema).optional().describe('Batch mode only, caller order.'),
});

// sec_lookup_duty
export const secLookupDutyRoleSchema = z.object({
  role_name: z.string(),
  permission_type: z.string().nullish(),
});
export const secLookupDutyPrivilegeSchema = z.object({
  privilege_name: z.string(),
  label: z.string().nullish(),
});
export const secLookupDutyOutput = z.object({
  duty_id: z.string(),
  duty_name: z.string().nullish(),
  module_id: z.string().nullish(),
  description: z.string().nullish(),
  // Exact totals; each list holds at most `limit` rows (#107.6).
  role_count: z.number(),
  privilege_count: z.number(),
  truncated: z.boolean(),
  roles: z.array(secLookupDutyRoleSchema),
  privileges: z.array(secLookupDutyPrivilegeSchema),
});

// sec_lookup_privilege
export const secLookupPrivilegeEntryPointSchema = z.object({
  entry_point_name: z.string(),
  object_type: z.string().nullish(),
  object_name: z.string().nullish(),
  grant_read: z.string().nullish(),
  grant_create: z.string().nullish(),
  grant_update: z.string().nullish(),
  grant_delete: z.string().nullish(),
  grant_correct: z.string().nullish(),
  grant_invoke: z.string().nullish(),
});
export const secLookupPrivilegeDutySchema = z.object({
  duty_id: z.string(),
  duty_name: z.string().nullish(),
});
export const secLookupPrivilegeOutput = z.object({
  privilege_name: z.string(),
  module_id: z.string().nullish(),
  label: z.string().nullish(),
  // Exact totals; each list holds at most `limit` rows (#107.6).
  entry_point_count: z.number(),
  parent_duty_count: z.number(),
  granting_role_count: z.number(),
  truncated: z.boolean(),
  entry_points: z.array(secLookupPrivilegeEntryPointSchema),
  parent_duties: z.array(secLookupPrivilegeDutySchema),
  granting_roles: z.array(z.object({
    role_name: z.string(),
    permission_type: z.string().nullish(),
  })),
});

// sec_role_hierarchy
export const secRoleHierarchyEntrySchema = z.object({
  role_name: z.string(),
  is_transitive: z.number().nullish(),
  // Effective duty count of the related role (own ∪ sub-role, #114) — the
  // same number sec_lookup_role.duty_count reports for it.
  duty_count: z.number(),
});
export const secRoleHierarchyOutput = z.object({
  role_name: z.string(),
  direction: z.enum(['children', 'parents']),
  // Total number of related roles; `entries` holds at most `limit` of them.
  result_count: z.number(),
  truncated: z.boolean(),
  entries: z.array(secRoleHierarchyEntrySchema),
});

// sec_find_users_by_role
export const secUserRowSchema = z.object({
  user_id: z.string(),
  person_name: z.string().nullish(),
  email: z.string().nullish(),
  enabled: z.number().nullish(),
  company_id: z.string().nullish(),
});
export const secFindUsersByRoleOutput = z.object({
  role_name: z.string(),
  company_id: z.string().nullish(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  deny_role: z.boolean(),
  users: z.array(secUserRowSchema),
});

// sec_find_roles_by_duty
export const secFindRolesByDutyRowSchema = z.object({
  role_name: z.string(),
  permission_type: z.string().nullish(),
  license_type: z.string().nullish(),
  duty_permission: z.string().nullish(),
});
export const secFindRolesByDutyOutput = z.object({
  duty_id: z.string(),
  result_count: z.number(),
  truncated: z.boolean(),
  roles: z.array(secFindRolesByDutyRowSchema),
  ...pageShape,
});

// sec_find_roles_by_privilege
export const secFindRolesByPrivilegeViaChainRowSchema = z.object({
  role_name: z.string(),
  permission_type: z.string().nullish(),
  duty_id: z.string(),
});
export const secFindRolesByPrivilegeDirectRowSchema = z.object({
  role_name: z.string(),
});
export const secFindRolesByPrivilegeOutput = z.object({
  privilege_name: z.string(),
  via_chain_count: z.number(),
  direct_count: z.number(),
  truncated: z.boolean(),
  via_chain: z.array(secFindRolesByPrivilegeViaChainRowSchema),
  direct: z.array(secFindRolesByPrivilegeDirectRowSchema),
  ...pageShape,
});

// sec_company_users
export const secCompanyUserRowSchema = z.object({
  user_id: z.string(),
  person_name: z.string().nullish(),
  email: z.string().nullish(),
  role_name: z.string(),
  permission_type: z.string().nullish(),
});
export const secCompanyUsersOutput = z.object({
  company_id: z.string(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  assignments: z.array(secCompanyUserRowSchema),
});

// sec_permission_trace
export const secPermissionTraceRowSchema = z.object({
  permission_type: z.string().nullish(),
  duty_id: z.string().nullish(),
  priv_name: z.string(),
  object_type: z.string().nullish(),
  object_name: z.string().nullish(),
  grant_read: z.string().nullish(),
  grant_create: z.string().nullish(),
  grant_update: z.string().nullish(),
  grant_delete: z.string().nullish(),
  grant_correct: z.string().nullish(),
  grant_invoke: z.string().nullish(),
});
export const secPermissionTraceOutput = z.object({
  role_name: z.string(),
  object_name: z.string().nullish(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  grant_count: z.number(),
  deny_count: z.number(),
  rows: z.array(secPermissionTraceRowSchema),
});

// sec_compare_roles
// Each of the six lists is capped at `list_limit`; the `*_count` keys hold the
// full sizes and `truncated` says whether any list was cut.
export const secCompareRolesOutput = z.object({
  role1: z.string(),
  role2: z.string(),
  list_limit: z.number(),
  truncated: z.boolean(),
  duties_total_1: z.number(),
  duties_total_2: z.number(),
  duties_shared_count: z.number(),
  duties_only_1_count: z.number(),
  duties_only_2_count: z.number(),
  duties_shared: z.array(z.string()),
  duties_only_1: z.array(z.string()),
  duties_only_2: z.array(z.string()),
  direct_privs_total_1: z.number(),
  direct_privs_total_2: z.number(),
  direct_privs_shared_count: z.number(),
  direct_privs_only_1_count: z.number(),
  direct_privs_only_2_count: z.number(),
  direct_privs_shared: z.array(z.string()),
  direct_privs_only_1: z.array(z.string()),
  direct_privs_only_2: z.array(z.string()),
});

// sec_search
export const secSearchRowSchema = z.object({
  object_type: z.string().nullish(),
  object_name: z.string(),
  module_id: z.string().nullish(),
  match_context: z.string().nullish(),
});
export const secSearchOutput = z.object({
  query: z.string(),
  object_type: z.string().nullish(),
  modules: z.array(z.string()).nullish(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  results: z.array(secSearchRowSchema),
  ...pageShape,
});

// sec_stats
export const secStatsMetadataEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
});
export const secStatsOutput = z.object({
  build_info: z.array(secStatsMetadataEntrySchema),
  // Scanned models: count + per-origin breakdown (0 on sec databases built
  // before model_versions capture). The full per-model list (37 KB on a real
  // snapshot) is present only with include_model_versions=true (#107.2).
  model_count: z.number(),
  models_by_origin: z.object({
    microsoft: z.number(),
    isv: z.number(),
    custom: z.number(),
  }),
  model_versions: z.array(modelVersionRowSchema).optional(),
  grant_roles: z.number(),
  deny_roles: z.number(),
  total_duties: z.number(),
  total_privileges: z.number(),
  total_entry_points: z.number(),
  enabled_users: z.number(),
  disabled_users: z.number(),
  user_role_assignments: z.number(),
  companies: z.number(),
});

// ── sec_licence_assessment ───────────────────────────────────────────────────

export const secLicenceUserRowSchema = z.object({
  user_id: z.string(),
  person_name: z.string().nullish(),
  required_tier: z.string().nullish(),
  monthly_cost: z.number(),
  driving_role: z.string().nullish(),
  role_count: z.number(),
});
export const secLicenceAssessmentOutput = z.object({
  mode: z.enum(['single', 'all']),
  user_count: z.number(),
  limit: z.number(),
  truncated: z.boolean(),
  tier_summary: z.array(z.object({
    tier: z.string(),
    user_count: z.number(),
    monthly_cost_per_user: z.number(),
  })),
  users: z.array(secLicenceUserRowSchema),
});

// ── sec_what_if ─────────────────────────────────────────────────────────────

export const secWhatIfOutput = z.object({
  user_id: z.string(),
  person_name: z.string().nullish(),
  add_roles: z.array(z.string()),
  remove_roles: z.array(z.string()),
  current_tier: z.string().nullish(),
  current_monthly_cost: z.number(),
  projected_tier: z.string().nullish(),
  projected_monthly_cost: z.number(),
  monthly_delta: z.number(),
  annual_delta: z.number(),
  current_role_count: z.number(),
  projected_role_count: z.number(),
  current_roles: z.array(z.string()),
  projected_roles: z.array(z.string()),
  warnings: z.array(z.string()),
});

// ── sec_object_access ───────────────────────────────────────────────────────

export const secObjectAccessPathSchema = z.object({
  role_name: z.string(),
  permission_type: z.string().nullish(),
  duty_id: z.string().nullish(),
  privilege_name: z.string(),
  entry_point_name: z.string(),
  object_type: z.string().nullish(),
  grant_read: z.string().nullish(),
  grant_create: z.string().nullish(),
  grant_update: z.string().nullish(),
  grant_delete: z.string().nullish(),
  grant_correct: z.string().nullish(),
  grant_invoke: z.string().nullish(),
  // true when this path REMOVES access (Deny duty/role, or a Deny grant value).
  denied: z.boolean(),
});
export const secObjectAccessOutput = z.object({
  object_name: z.string(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  user_count: z.number(),
  role_count: z.number(),
  grant_path_count: z.number(),
  deny_path_count: z.number(),
  paths: z.array(secObjectAccessPathSchema),
  users: z.array(z.object({
    user_id: z.string(),
    person_name: z.string().nullish(),
    role_name: z.string(),
  })),
});

// ── Preflight existence checks (#118, Q5) ────────────────────────────────────
// Batch is the ONLY shape: one target is a batch of one, a miss is data in
// `not_found` (batching rule 2), never notFoundResult. Kept deliberately small —
// these tools exist to be cheap on tools/list (≤ 1.2 KB output schema each,
// asserted in test/tool-schema-budget.test.js).
export const xrefCheckExistsOutput = z.object({
  requested_count: z.number(),
  found_count: z.number(),
  objects: z.array(z.object({
    name: z.string(),
    exists: z.boolean(),
    type: z.string(),
    module: z.string().nullish(),
    path: z.string(),
  })),
  not_found: z.array(z.object({ name: z.string(), suggestions: z.array(z.string()) })),
});

export const secCheckExistsOutput = z.object({
  requested_count: z.number(),
  found_count: z.number(),
  artefacts: z.array(z.object({
    name: z.string(),
    exists: z.boolean(),
    kind: z.string(),
    label: z.string().nullish(),
    canonical_name: z.string(),
  })),
  not_found: z.array(z.object({ name: z.string(), kind: z.string(), suggestions: z.array(z.string()) })),
});

// ── Task Recorder (1) ────────────────────────────────────────────────────────
//
// taskrecorder_to_markdown is unique in the suite — its primary artifact IS
// the Markdown document (an H1-headed test case report). The typed payload
// exposes the rendered Markdown plus metadata so a downstream LLM can route
// by file name / source / size without re-parsing the document.
export const taskrecorderToMarkdownOutput = z.object({
  file_name: z.string(),
  source: z.enum(['url', 'content']),
  file_size_bytes: z.number(),
  markdown_length: z.number(),
  markdown: z.string(),
});

// ── Wiki MCP (4) ─────────────────────────────────────────────────────────────
//
// One MCP server per wiki (see src/azure/wiki-tools.js), sharing this tool
// shape so any blob-backed markdown wiki can be exposed by dropping an
// entry into config/wikis.json. The typed payload mirrors the rendered
// Markdown — the LLM can pick whichever is cheaper to consume.

export const wikiIndexOutput = z.object({
  wiki_name: z.string(),
  wiki_title: z.string(),
  present: z.boolean(),          // false → index.md doesn't exist yet
  content: z.string(),            // '' when present=false
  page_count: z.number(),
  last_modified: z.string().nullish(),
});

export const wikiListPageSchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullish(),
  tags: z.array(z.string()),
  last_modified: z.string().nullish(),
  size_bytes: z.number(),
});

export const wikiListOutput = z.object({
  wiki_name: z.string(),
  wiki_title: z.string(),
  total: z.number(),
  pages: z.array(wikiListPageSchema),
  truncated: z.boolean(),
});

export const wikiReadOutput = z.object({
  wiki_name: z.string(),
  slug: z.string(),
  title: z.string(),
  blob_name: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  content: z.string(),           // raw markdown, frontmatter included
  body: z.string(),               // markdown with frontmatter stripped
  last_modified: z.string().nullish(),
});

export const wikiSearchMatchSchema = z.object({
  slug: z.string(),
  title: z.string(),
  score: z.number(),
  snippets: z.array(z.string()),
});

export const wikiSearchOutput = z.object({
  wiki_name: z.string(),
  wiki_title: z.string(),
  query: z.string(),
  total_pages_scanned: z.number(),
  total_matches: z.number(),
  matches: z.array(wikiSearchMatchSchema),
  truncated: z.boolean(),
});


// ── Task Recorder: taskrecorder_to_markdown ──────────────────────────────────

export const taskrecorderMarkdownOutput = z.object({
  markdown: z.string().describe('The full Markdown rendering of the recording (same as the text channel).'),
  file_name: z.string().describe('The recording filename used in the document footer.'),
});

// ── Task Recorder: taskrecorder_to_document ──────────────────────────────────
//
// NOTE: this payload is a SUMMARY of the generated document, not the document
// itself. The MHTML deliverable is at `output_path` (or in `document_mhtml`
// when return_inline=true). Use these fields to confirm coverage and to decide
// whether to open the file.

// Output prose here was 2.7 KB on every tools/list (W1, #105) — the one place
// output `.describe()` measured as significant. Kept only where a key name
// does not carry the meaning; the response's `notes` explain the rest.
export const taskrecorderDocStepSchema = z.object({
  step: z.number(),
  source: z.string().describe('client | word | recording'),
  docx_text: z.string().nullish(),
  description: z.string().nullish(),
  action_type: z.string().nullish().describe('Client kind (navigate/click/edit/error) or .axtr node type.'),
  target: z.string().nullish(),
  global_id: z.string().nullish(),
  object_name: z.string().nullish().describe('AOT object touched — join key to BPM security.'),
  screenshot_count: z.number(),
  has_security: z.boolean(),
  matched_action_count: z.number().describe('Server (.axtr) actions correlated to this client step.'),
  texts_agree: z.boolean().describe('False flags a Word/recording text mismatch.'),
});

export const taskrecorderClientRecordingSchema = z.object({
  session_id: z.string().nullish(),
  title: z.string().nullish(),
  host: z.string().nullish(),
  tenant: z.string().nullish(),
  company: z.string().nullish(),
  started_at: z.string().nullish(),
  ended_at: z.string().nullish(),
  step_count: z.number(),
  screenshot_count: z.number(),
  matched_step_count: z.number(),
});

export const taskrecorderDocFormSchema = z.object({
  form_name: z.string(),
  kb_available: z.boolean(),
  kb_found: z.boolean(),
  class_count: z.number(),
  endpoint_count: z.number(),
});

export const taskrecorderDocRoleSchema = z.object({
  queried: z.string().describe('BPM role id (AOT name or DMF GUID).'),
  role_name: z.string().nullish(),
  found: z.boolean(),
  sub_role_count: z.number(),
  duty_count: z.number(),
  privilege_count: z.number(),
  user_count: z.number().describe('Full count, not the truncated list.'),
});

export const taskrecorderDocumentOutput = z.object({
  recording: z.object({
    name: z.string(),
    description: z.string().nullish(),
    canonical_id: z.string().nullish(),
    version: z.string().nullish(),
    language: z.string().nullish(),
    action_count: z.number(),
  }),
  step_count: z.number(),
  screenshot_count: z.number(),
  screenshots_present: z.boolean(),
  client_recording: taskrecorderClientRecordingSchema.nullish().describe('Client repro recording metadata, when supplied.'),
  steps: z.array(taskrecorderDocStepSchema).describe('Per-step client ↔ server ↔ BPM mapping.'),
  forms_enriched: z.array(taskrecorderDocFormSchema),
  roles_enriched: z.array(taskrecorderDocRoleSchema),
  bpm_role_count: z.number().describe('Distinct grants in the BPM package.'),
  kb_available: z.boolean(),
  sec_available: z.boolean(),
  output_path: z.string().nullish().describe('Path of the .mhtml — open this to view the document.'),
  byte_size: z.number(),
  document_mhtml: z.string().nullish().describe('Full MHTML, only with return_inline=true.'),
  xml_output_path: z.string().nullish().describe('Contract XML path (include_xml=true); validates against schemas/task-recording-document.xsd.'),
  document_xml: z.string().nullish().describe('Full XML, only with include_xml AND return_inline.'),
  notes: z.array(z.string()).describe('Warnings, e.g. no screenshots, KB not available.'),
});

// ── Sealed-ISV tools (issues #75–#82) ────────────────────────────────────────
// Sealed ISV models ship no X++ source and no Ax<Type> XML, so everything below
// is read from the model's own `bin/` artefacts and lives in separate `isv_*`
// tables. Every payload carries `fidelity` so a caller can never mistake
// ISV-published metadata for the fully-parsed KB/XRef data.

/** Provenance every sealed-ISV response repeats, so it is never implicit. */
export const isvProvenanceSchema = z.object({
  fidelity: z.string().describe("'metadata' (shipped artefacts) or 'il' (assembly signatures)."),
  source_kind: z.string().describe("Always 'sealed': binary-only, no X++ source."),
  scanned_at: z.string().nullish().describe('ISV scan timestamp; may differ from the snapshot date.'),
  caveat: z.string().describe('What this data cannot tell you.'),
});

/**
 * Provenance for IL-derived rows (issue #81) — a *separate* schema from
 * isvProvenanceSchema on purpose.
 *
 * An assembly signature is a weaker claim than metadata the ISV published for
 * the runtime to consume, and the two must not render identically. Collapsing
 * them into one shape is exactly how a caller ends up treating "this method
 * takes a BankAccountTable" and "this method reconciles bank statements" as the
 * same grade of fact.
 */
export const isvIlProvenanceSchema = z.object({
  fidelity: z.literal('il'),
  source_kind: z.string().describe("Always 'assembly-metadata' (ECMA-335 tables, not X++)."),
  scanned_at: z.string().nullish(),
  caveat: z.string().describe('Signatures are exact; behaviour is unknown — no body was decompiled or stored.'),
});

export const d365IsvListModelsOutput = z.object({
  isv_data_available: z.boolean().describe('False when the database predates the ISV scan or no ISV root was configured.'),
  model_count: z.number(),
  models: z.array(z.object({
    model: z.string(),
    publisher: z.string().nullish().describe("From the assembly version resource, or 'unknown'."),
    version: z.string().nullish(),
    layer: z.string().nullish().describe('Always null: sealed models ship no Descriptor.'),
    source_kind: z.string(),
    fidelity: z.string(),
    depends_on: z.array(z.string()).describe('Declared module dependencies (.xref ModuleReferences).'),
    scanned_at: z.string().nullish(),
    counts: z.record(z.string(), z.number()).describe('Recovered per artefact class: elements, labels, refs, coc, events.'),
  })),
  provenance: isvProvenanceSchema,
});

/**
 * One IL-derived method signature (issue #81).
 *
 * `fidelity: 'il'` throughout: these rows come from the assembly's metadata
 * tables, never from X++ source. The contract is exact; the behaviour is
 * unknown and is not represented here because nothing in the pipeline can know
 * it — no body is decompiled, disassembled or stored.
 */
// Output prose on the ISV schemas was 6.7 KB on every tools/list (W1, #105):
// the caveats it carried are repeated in every RESPONSE by isvProvenance() /
// isvIlProvenance(), which is where a caller reads them. Kept short here.
export const isvIlSignatureSchema = z.object({
  module: z.string(),
  assembly: z.string().nullish().describe('Image the signature was read from.'),
  namespace: z.string().nullish().describe('CLR namespace — a table and its form share a name in different namespaces.'),
  type_name: z.string(),
  method_name: z.string(),
  kind: z.string().nullish().describe('method | constructor | accessor (accessors are excluded from responses).'),
  return_type: z.string().nullish(),
  parameters: z.array(z.object({
    name: z.string().describe('Declared name, or `argN` when the compiler emitted none.'),
    type: z.string(),
    optional: z.boolean().optional().describe('True when X++ declared a default.'),
  })),
  visibility: z.string().nullish().describe('public | protected | private | internal | …'),
  is_static: z.boolean(),
  is_abstract: z.boolean(),
  is_virtual: z.boolean(),
  is_final: z.boolean(),
  has_implementation: z.boolean().describe('MethodDef.RVA != 0; the body itself is never read.'),
  attributes: z.array(z.string()).describe('Attribute type names only; arguments not decoded.'),
  fidelity: z.literal('il'),
});

export const d365IsvLookupOutput = z.object({
  isv_data_available: z.boolean(),
  name: z.string(),
  found: z.boolean(),
  match_count: z.number(),
  matches: z.array(z.object({
    module: z.string(),
    element_type: z.string().describe('AOT type, e.g. AxTable, AxClass, AxForm.'),
    name: z.string(),
    blob_size: z.number().nullish().describe('Byte length of the undecoded property blob.'),
    properties: z.array(z.object({
      property: z.string().nullish().describe('Resolved name, or null when the tag is not yet pinned.'),
      tag: z.string().describe('Raw property tag, kept verbatim.'),
      value: z.string().nullish(),
    })).describe('Decoded properties; empty when the type has no confirmed tag map.'),
  })),
  signatures_available: z.boolean().describe('False when the IL pass was not run or include_signatures not set.'),
  signature_count: z.number(),
  signatures: z.array(isvIlSignatureSchema).describe("Only with include_signatures. fidelity='il' — weaker than the shipped metadata."),
  il_provenance: isvIlProvenanceSchema.nullish().describe('Provenance for `signatures`; null when none.'),
  il_command: z.object({
    available: z.boolean(),
    note: z.string().describe('No IL, body or source is held; running the commands is the operator\'s own action under the vendor licence.'),
    targets: z.array(z.object({
      module: z.string(),
      assembly: z.string().describe('Image declaring the type (commonly a .netmodule).'),
      assembly_path: z.string(),
      qualified_type: z.string(),
      ildasm: z.string().describe('Windows SDK ildasm invocation (filename before options).'),
      ilspycmd_install: z.string().describe('One-off dotnet tool install.'),
      ilspycmd: z.string().describe('ilspycmd invocation; emits reconstructed C#, a translation.'),
      ilspycmd_caveat: z.string().nullish().describe('Set when the image is a .netmodule ILSpy cannot load standalone.'),
    })),
  }).nullish().describe('Only with include_il_command. Commands for the operator to run locally — never IL, a body or source.'),
  provenance: isvProvenanceSchema,
});

export const d365IsvExtensionPointsOutput = z.object({
  isv_data_available: z.boolean(),
  target: z.string().nullish().describe('Standard object asked about; null when listing a module.'),
  module_filter: z.string().nullish(),
  coc_count: z.number(),
  event_count: z.number(),
  extends_count: z.number(),
  chain_of_command: z.array(z.object({
    module: z.string(),
    extension_class: z.string(),
    target: z.string().nullish(),
    target_type: z.string().nullish(),
    method: z.string().nullish().describe('Wrapped method; null when none is listed.'),
    is_static: z.boolean(),
    signature: isvIlSignatureSchema.nullish().describe("Wrapped method's signature (include_signatures, IL pass run); fidelity='il'."),
  })),
  event_handlers: z.array(z.object({
    module: z.string(),
    delegate_element: z.string().nullish(),
    delegate_method: z.string().nullish(),
    handler_element: z.string().nullish(),
    handler_method: z.string().nullish(),
    direction: z.string().nullish().describe('Pre / Post / other.'),
  })),
  extends: z.array(z.object({
    module: z.string(),
    kind: z.string().describe('class | table | edt | odata'),
    child: z.string(),
    parent: z.string().nullish(),
  })),
  signatures_available: z.boolean().describe('False when the IL pass was not run or include_signatures not set.'),
  il_provenance: isvIlProvenanceSchema.nullish().describe('Provenance for attached signatures; null when none.'),
  truncated: z.boolean(),
  provenance: isvProvenanceSchema,
});

export const xrefIsvFindUsagesOutput = z.object({
  isv_data_available: z.boolean(),
  object_name: z.string(),
  usage_count: z.number(),
  module_summary: z.array(z.object({
    module: z.string(),
    reference_count: z.number(),
  })).describe('Referencing sealed ISV models, most references first.'),
  usages: z.array(z.object({
    module: z.string(),
    source_path: z.string().describe('Referencing element path.'),
    target_path: z.string(),
    kind: z.string().nullish().describe('TypeReference | MethodCall | Attribute | ClassExtended | MethodOverride | Property.'),
    line: z.number().nullish(),
    col: z.number().nullish(),
  })),
  truncated: z.boolean(),
  provenance: isvProvenanceSchema,
});

// ── Semantic layer (ADR W7 + W7b, issue #111) ────────────────────────────────
//
// Metadata-only payloads: entity ids, object/field names, roles, declarative
// specs, provenance. No row data, no sample values — see semantic-store.js.

export const semMappedObjectSchema = z.object({
  object_type: z.string(),
  object_name: z.string(),
  model: z.string().nullish(),
  role: z.string().describe('header | line | master | setup | transaction | reference | posting | ui'),
  source: z.string().describe('user_confirmed | assistant_inferred | context_hint | seed'),
  confidence: z.number(),
  confirmations: z.number(),
  verified: z.boolean().describe('True when the object exists in the KB snapshot.'),
});

export const d365MapEntityOutput = z.object({
  entity_id: z.string(),
  entity_name: z.string(),
  process: z.string(),
  source: z.string(),
  inserted: z.number(),
  confirmed: z.number(),
  unchanged: z.number(),
  unverified_objects: z.array(z.string()).describe('Objects not found in the KB; recorded with verified=false.'),
  objects: z.array(semMappedObjectSchema),
});

export const d365MapDqRuleOutput = z.object({
  rule_id: z.string(),
  version: z.number(),
  action: z.string().describe('inserted | versioned | confirmed | unchanged'),
  entity_id: z.string().nullish(),
  object_name: z.string().nullish(),
  field_name: z.string().nullish(),
  dimension: z.string(),
  severity: z.string(),
  source: z.string(),
  confidence: z.number(),
  enabled: z.boolean(),
  spec: z.record(z.string(), z.unknown()),
});

export const d365EntityMapOutput = z.object({
  direction: z.string().describe('forward (entity -> objects) | reverse (object -> entities)'),
  entity_id: z.string().nullish(),
  entity_name: z.string().nullish(),
  process: z.string().nullish(),
  object_name: z.string().nullish(),
  mapping_count: z.number(),
  by_role: z.array(z.object({
    role: z.string(),
    objects: z.array(semMappedObjectSchema),
  })).describe('Forward direction only; empty in reverse.'),
  entities: z.array(z.object({
    entity_id: z.string(),
    entity_name: z.string().nullish(),
    process: z.string().nullish(),
    role: z.string(),
    source: z.string(),
    confidence: z.number(),
    confirmations: z.number(),
  })).describe('Reverse direction only; empty in forward.'),
  related_entities: z.array(z.object({
    entity_id: z.string(),
    relation: z.string(),
    direction: z.string().describe('out | in'),
  })),
});

export const semDqRuleSchema = z.object({
  rule_id: z.string(),
  version: z.number(),
  entity_id: z.string().nullish(),
  object_name: z.string().nullish(),
  field_name: z.string().nullish(),
  dimension: z.string(),
  spec: z.record(z.string(), z.unknown()),
  severity: z.string(),
  source: z.string().describe('kb_derived | user_confirmed | assistant_inferred | seed'),
  confidence: z.number(),
  enabled: z.boolean(),
  binding: z.string().describe('object | entity:<id> — how the rule became applicable.'),
});

export const d365DqRulesOutput = z.object({
  entity_id: z.string().nullish(),
  object_name: z.string().nullish(),
  rule_count: z.number(),
  by_dimension: z.array(z.object({ dimension: z.string(), count: z.number() })),
  rules: z.array(semDqRuleSchema),
  truncated: z.boolean(),
  note: z.string().describe('Rules are served, never executed here; render with build/gen-dq-sql.js.'),
});

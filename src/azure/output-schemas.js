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

// ── Pilot 1: d365_lookup_table ───────────────────────────────────────────────

export const d365LookupTableFieldSchema = z.object({
  name: z.string(),
  type: z.string().nullable(),
  edt: z.string().nullable(),
  enum_type: z.string().nullable(),
  label: z.string().nullable(),
  mandatory: z.number().nullable(),
  // Customization provenance (false / null on standard Microsoft fields, and
  // on KB databases built before the customization columns existed).
  is_extension: z.boolean(),
  source_module: z.string().nullable(),
});

export const d365LookupTableIndexSchema = z.object({
  name: z.string(),
  is_unique: z.boolean(),
  is_clustered: z.boolean(),
  fields: z.array(z.string()),
});

export const d365LookupTableRelationSchema = z.object({
  relation_name: z.string().nullable(),
  related_table: z.string().nullable(),
  join_fields: z.array(z.object({
    field: z.string().nullable(),
    related_field: z.string().nullable(),
  })),
  relationship_type: z.string().nullable(),
  on_delete: z.string().nullable(),
});

export const d365LookupTableIncomingRelationSchema = z.object({
  source_table: z.string().nullable(),
  relation_name: z.string().nullable(),
  join_fields: z.array(z.object({
    field: z.string().nullable(),
    related_field: z.string().nullable(),
  })),
});

export const d365LookupTableOutput = z.object({
  table_name: z.string(),
  module_id: z.string().nullable(),
  label: z.string().nullable(),
  table_group: z.string().nullable(),
  save_per_company: z.number().nullable(),
  cache_lookup: z.string().nullable(),
  clustered_index: z.string().nullable(),
  replacement_key: z.string().nullable(),
  field_count: z.number(),
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
});

// ── Pilot 2: d365_get_class_methods ──────────────────────────────────────────

export const d365ClassMethodSchema = z.object({
  method_name: z.string(),
  signature: z.string().nullable(),
  is_static: z.boolean(),
  source_code: z.string().nullable(),
});

export const d365GetClassMethodsOutput = z.object({
  owner_name: z.string(),
  owner_type: z.string(),
  extends_class: z.string().nullable(),
  implements_list: z.string().nullable(),
  is_abstract: z.boolean(),
  include_source: z.boolean(),
  method_count: z.number(),
  methods: z.array(d365ClassMethodSchema),
  truncated: z.boolean(),
});

// ── Pilot 3: xref_impact_analysis ────────────────────────────────────────────

export const xrefImpactReferencingObjectSchema = z.object({
  source: z.string(),
  kind: z.string(),
  module: z.string().nullable(),
});

export const xrefImpactAnalysisOutput = z.object({
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
  permission_type: z.string().nullable(),
  license_type: z.string().nullable(),
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
  permission_type: z.string().nullable(),
});

export const secLookupUserDenyOverrideSchema = z.object({
  role_name: z.string(),
  duty_id: z.string(),
  duty_name: z.string().nullable(),
});

export const secLookupUserOutput = z.object({
  user_id: z.string(),
  person_name: z.string().nullable(),
  email: z.string().nullable(),
  enabled: z.boolean(),
  default_company: z.string().nullable(),
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
  object_type: z.string().nullable(),
  grant_read: z.string().nullable(),
  grant_create: z.string().nullable(),
  grant_update: z.string().nullable(),
  grant_delete: z.string().nullable(),
  grant_correct: z.string().nullable(),
  grant_invoke: z.string().nullable(),
  duty_perm: z.string().nullable(),
  source: z.string().nullable().optional(),
});

// Deny-wins resolved view: one row per securable object after applying
// Deny-over-Grant per operation. Each effective_* is the net verdict —
// 'Allow', 'Deny', or null (no specification). `status` distinguishes a
// fully-granted object from one that is partly or wholly blocked, which
// maps directly to a UI control being enabled / greyed / hidden.
export const secEffectiveResolvedSchema = z.object({
  object_name: z.string(),
  object_type: z.string().nullable(),
  effective_read: z.string().nullable(),
  effective_create: z.string().nullable(),
  effective_update: z.string().nullable(),
  effective_delete: z.string().nullable(),
  effective_correct: z.string().nullable(),
  effective_invoke: z.string().nullable(),
  status: z.enum(['granted', 'partial', 'denied']),
});

export const secEffectivePermissionsOutput = z.object({
  subject_type: z.enum(['user', 'role']),
  subject_id: z.string(),
  subject_label: z.string(),
  role_count: z.number(),
  object_filter: z.string().nullable(),
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
  source_table: z.string().nullable(),
  related_table: z.string().nullable(),
  relation_name: z.string().nullable(),
  relationship_type: z.string().nullable(),
  join_pairs: z.array(z.object({
    source_field: z.string().nullable(),
    related_field: z.string().nullable(),
  })),
});
export const d365GetJoinKeysTrapSchema = z.object({
  trap_type: z.string(),
  wrong_value: z.string().nullable(),
  correct_value: z.string().nullable(),
  explanation: z.string().nullable(),
});
export const d365GetJoinKeysOutput = z.object({
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
  object_type: z.string().nullable(),
  object_name: z.string(),
  module_id: z.string().nullable(),
  context: z.string().nullable(),
});
export const d365SearchOutput = z.object({
  query: z.string(),
  object_type: z.string().nullable(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  results: z.array(d365SearchResultSchema),
});

// d365_get_enum — enum values
export const d365EnumValueSchema = z.object({
  name: z.string(),
  value: z.number().nullable(),
  label: z.string().nullable(),
});
export const d365GetEnumOutput = z.object({
  enum_name: z.string(),
  module_id: z.string().nullable(),
  label: z.string().nullable(),
  value_count: z.number(),
  values: z.array(d365EnumValueSchema),
  parse_error: z.boolean(),
});

// d365_check_field_exists — per-field existence + note
export const d365CheckFieldResultSchema = z.object({
  field_name: z.string(),
  exists: z.boolean(),
  correct_name: z.string().nullable(),
  note: z.string().nullable(),
  similar: z.array(z.string()),
});
export const d365CheckFieldExistsOutput = z.object({
  table_name: z.string(),
  check_count: z.number(),
  checks: z.array(d365CheckFieldResultSchema),
});

// d365_get_method_source — single method source
export const d365GetMethodSourceOutput = z.object({
  owner_type: z.string(),
  owner_name: z.string(),
  method_name: z.string(),
  signature: z.string().nullable(),
  is_static: z.boolean(),
  source_code: z.string().nullable(),
  // Body-relative line count (null when no source). Lets callers cite a line
  // range knowing the upper bound; the rendered Markdown is line-numbered.
  line_count: z.number().int().nullable(),
});

// d365_find_referencing_tables — tables referencing this table
export const d365FindReferencingTableSchema = z.object({
  source_table: z.string().nullable(),
  relation_name: z.string().nullable(),
  relationship_type: z.string().nullable(),
  join_fields: z.array(z.object({
    field: z.string().nullable(),
    related_field: z.string().nullable(),
  })),
});
export const d365FindReferencingTablesOutput = z.object({
  table_name: z.string(),
  reference_count: z.number(),
  references: z.array(d365FindReferencingTableSchema),
});

// d365_get_module_summary — module stats + key tables/classes
export const d365ModuleKeyTableSchema = z.object({
  table_name: z.string(),
  label: z.string().nullable(),
  field_count: z.number().nullable(),
  save_per_company: z.number().nullable(),
  table_group: z.string().nullable(),
});
export const d365ModuleKeyClassSchema = z.object({
  class_name: z.string(),
  extends_class: z.string().nullable(),
  method_count: z.number().nullable(),
});
export const d365GetModuleSummaryOutput = z.object({
  module_id: z.string(),
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
  data_field: z.string().nullable(),
  data_source: z.string().nullable(),
  is_mandatory: z.number().nullable(),
});
export const d365GetEntitySourcesOutput = z.object({
  entity_name: z.string(),
  module_id: z.string().nullable(),
  label: z.string().nullable(),
  public_name: z.string().nullable(),
  public_collection: z.string().nullable(),
  is_public: z.boolean(),
  primary_table: z.string().nullable(),
  staging_table: z.string().nullable(),
  config_key: z.string().nullable(),
  field_count: z.number(),
  entity_fields: z.array(d365EntityFieldSchema),
  // Entity-level X++ methods (empty on KB databases built before entity-method
  // extraction was added). Use d365_get_class_methods with include_source for
  // the full X++ body of any method.
  method_count: z.number(),
  methods: z.array(z.object({
    method_name: z.string(),
    signature: z.string().nullable(),
    is_static: z.boolean(),
  })),
});

// d365_sql_template — SQL templates
export const d365SqlTemplateSchema = z.object({
  template_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  sql_template: z.string(),
  tables_used: z.string().nullable(),
});
export const d365SqlTemplateOutput = z.object({
  scenario: z.string().nullable(),
  template_count: z.number(),
  templates: z.array(d365SqlTemplateSchema),
});

// d365_hallucination_check — trap list
export const d365HallucinationTrapSchema = z.object({
  trap_type: z.string(),
  wrong_value: z.string().nullable(),
  correct_value: z.string().nullable(),
  explanation: z.string().nullable(),
});
export const d365HallucinationCheckOutput = z.object({
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
  node_type: z.string().nullable(),
  edge: z.string().nullable(),
  depth: z.number(),
});
export const d365GraphTraverseOutput = z.object({
  start_node: z.string(),
  max_depth: z.number(),
  edge_type: z.string().nullable(),
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
  table_name: z.string(),
  rename_count: z.number(),
  renames: z.array(d365FieldRenameSchema),
});

// d365_list_modules — module count + rows
export const d365ModuleRowSchema = z.object({
  module_id: z.string(),
  table_count: z.number().nullable(),
  class_count: z.number().nullable(),
  enum_count: z.number().nullable(),
  entity_count: z.number().nullable(),
  form_count: z.number().nullable(),
});
export const d365ListModulesOutput = z.object({
  module_count: z.number(),
  modules: z.array(d365ModuleRowSchema),
});

// d365_resolve_label — label resolution result
export const d365ResolvedLabelSchema = z.object({
  label_id: z.string(),
  text: z.string(),
});
export const d365ResolveLabelOutput = z.object({
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
  kind: z.string().nullable(),
  line: z.number().nullable(),
  col: z.number().nullable(),
  module: z.string().nullable(),
});

// xref_find_references
export const xrefFindReferencesOutput = z.object({
  target_path: z.string(),
  kind_filter: z.string(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  references: z.array(xrefRefRowSchema),
});

// xref_find_usages
export const xrefFindUsagesOutput = z.object({
  source_path: z.string(),
  kind_filter: z.string(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  usages: z.array(xrefRefRowSchema),
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
    line: z.number().nullable(),
    col: z.number().nullable(),
    module: z.string().nullable(),
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
  result_count: z.number(),
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
  result_count: z.number(),
  implementors: z.array(xrefInterfaceImplementorSchema),
});

// xref_search_names
export const xrefSearchNameRowSchema = z.object({
  path: z.string(),
  module: z.string().nullable(),
});
export const xrefSearchNamesOutput = z.object({
  pattern: z.string(),
  object_type: z.string(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  results: z.array(xrefSearchNameRowSchema),
});

// xref_method_references
export const xrefMethodReferenceRowSchema = z.object({
  path: z.string(),
  kind: z.string().nullable(),
  line: z.number().nullable(),
  col: z.number().nullable(),
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
  provider: z.string().nullable(),
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
});
export const xrefListModulesOutput = z.object({
  module_count: z.number(),
  modules: z.array(xrefListModuleRowSchema),
});

// xref_object_summary
export const xrefObjectSummaryKindCountSchema = z.object({
  kind: z.string(),
  count: z.number(),
});
export const xrefObjectSummaryOutput = z.object({
  object_path: z.string(),
  module: z.string().nullable(),
  sub_object_count: z.number(),
  methods: z.array(z.string()),
  incoming_total: z.number(),
  outgoing_total: z.number(),
  incoming_by_kind: z.array(xrefObjectSummaryKindCountSchema),
  outgoing_by_kind: z.array(xrefObjectSummaryKindCountSchema),
});

// xref_find_extensions
export const xrefExtensionRowSchema = z.object({
  path: z.string(),
  module: z.string().nullable(),
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
  line: z.number().nullable(),
  col: z.number().nullable(),
  module: z.string().nullable(),
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
  module: z.string().nullable(),
});
export const xrefFindEventHandlersOutput = z.object({
  object_name: z.string(),
  method_name: z.string().nullable(),
  object_path: z.string().nullable(),
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
  is_transitive: z.number().nullable(),
});
export const secLookupRoleDutySchema = z.object({
  duty_id: z.string(),
  duty_name: z.string().nullable(),
  permission_type: z.string().nullable(),
});
export const secLookupRoleDirectEntityPermissionSchema = z.object({
  entity_name: z.string(),
  grant_read: z.string().nullable(),
  grant_create: z.string().nullable(),
  grant_update: z.string().nullable(),
  grant_delete: z.string().nullable(),
  grant_correct: z.string().nullable(),
  grant_invoke: z.string().nullable(),
});
export const secLookupRoleOutput = z.object({
  role_id: z.string(),
  role_name: z.string(),
  module_id: z.string().nullable(),
  label: z.string().nullable(),
  description: z.string().nullable(),
  license_type: z.string().nullable(),
  permission_type: z.string().nullable(),
  source: z.string().nullable(),
  sub_roles: z.array(secLookupRoleSubRoleSchema),
  duties: z.array(secLookupRoleDutySchema),
  direct_privileges: z.array(z.string()),
  direct_entity_permissions: z.array(secLookupRoleDirectEntityPermissionSchema),
  assigned_user_count: z.number(),
});

// sec_lookup_duty
export const secLookupDutyRoleSchema = z.object({
  role_name: z.string(),
  permission_type: z.string().nullable(),
});
export const secLookupDutyPrivilegeSchema = z.object({
  privilege_name: z.string(),
  label: z.string().nullable(),
});
export const secLookupDutyOutput = z.object({
  duty_id: z.string(),
  duty_name: z.string().nullable(),
  module_id: z.string().nullable(),
  description: z.string().nullable(),
  roles: z.array(secLookupDutyRoleSchema),
  privileges: z.array(secLookupDutyPrivilegeSchema),
});

// sec_lookup_privilege
export const secLookupPrivilegeEntryPointSchema = z.object({
  entry_point_name: z.string(),
  object_type: z.string().nullable(),
  object_name: z.string().nullable(),
  grant_read: z.string().nullable(),
  grant_create: z.string().nullable(),
  grant_update: z.string().nullable(),
  grant_delete: z.string().nullable(),
  grant_correct: z.string().nullable(),
  grant_invoke: z.string().nullable(),
});
export const secLookupPrivilegeDutySchema = z.object({
  duty_id: z.string(),
  duty_name: z.string().nullable(),
});
export const secLookupPrivilegeOutput = z.object({
  privilege_name: z.string(),
  module_id: z.string().nullable(),
  label: z.string().nullable(),
  entry_points: z.array(secLookupPrivilegeEntryPointSchema),
  parent_duties: z.array(secLookupPrivilegeDutySchema),
  granting_roles: z.array(z.object({
    role_name: z.string(),
    permission_type: z.string().nullable(),
  })),
});

// sec_role_hierarchy
export const secRoleHierarchyEntrySchema = z.object({
  role_name: z.string(),
  is_transitive: z.number().nullable(),
});
export const secRoleHierarchyOutput = z.object({
  role_name: z.string(),
  direction: z.enum(['children', 'parents']),
  result_count: z.number(),
  entries: z.array(secRoleHierarchyEntrySchema),
});

// sec_find_users_by_role
export const secUserRowSchema = z.object({
  user_id: z.string(),
  person_name: z.string().nullable(),
  email: z.string().nullable(),
  enabled: z.number().nullable(),
  company_id: z.string().nullable(),
});
export const secFindUsersByRoleOutput = z.object({
  role_name: z.string(),
  company_id: z.string().nullable(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  deny_role: z.boolean(),
  users: z.array(secUserRowSchema),
});

// sec_find_roles_by_duty
export const secFindRolesByDutyRowSchema = z.object({
  role_name: z.string(),
  permission_type: z.string().nullable(),
  license_type: z.string().nullable(),
  duty_permission: z.string().nullable(),
});
export const secFindRolesByDutyOutput = z.object({
  duty_id: z.string(),
  result_count: z.number(),
  roles: z.array(secFindRolesByDutyRowSchema),
});

// sec_find_roles_by_privilege
export const secFindRolesByPrivilegeViaChainRowSchema = z.object({
  role_name: z.string(),
  permission_type: z.string().nullable(),
  duty_id: z.string(),
});
export const secFindRolesByPrivilegeDirectRowSchema = z.object({
  role_name: z.string(),
});
export const secFindRolesByPrivilegeOutput = z.object({
  privilege_name: z.string(),
  via_chain_count: z.number(),
  direct_count: z.number(),
  via_chain: z.array(secFindRolesByPrivilegeViaChainRowSchema),
  direct: z.array(secFindRolesByPrivilegeDirectRowSchema),
});

// sec_company_users
export const secCompanyUserRowSchema = z.object({
  user_id: z.string(),
  person_name: z.string().nullable(),
  email: z.string().nullable(),
  role_name: z.string(),
  permission_type: z.string().nullable(),
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
  permission_type: z.string().nullable(),
  duty_id: z.string().nullable(),
  priv_name: z.string(),
  object_type: z.string().nullable(),
  object_name: z.string().nullable(),
  grant_read: z.string().nullable(),
  grant_create: z.string().nullable(),
  grant_update: z.string().nullable(),
  grant_delete: z.string().nullable(),
  grant_correct: z.string().nullable(),
  grant_invoke: z.string().nullable(),
});
export const secPermissionTraceOutput = z.object({
  role_name: z.string(),
  object_name: z.string().nullable(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  grant_count: z.number(),
  deny_count: z.number(),
  rows: z.array(secPermissionTraceRowSchema),
});

// sec_compare_roles
export const secCompareRolesOutput = z.object({
  role1: z.string(),
  role2: z.string(),
  duties_total_1: z.number(),
  duties_total_2: z.number(),
  duties_shared: z.array(z.string()),
  duties_only_1: z.array(z.string()),
  duties_only_2: z.array(z.string()),
  direct_privs_total_1: z.number(),
  direct_privs_total_2: z.number(),
  direct_privs_shared: z.array(z.string()),
  direct_privs_only_1: z.array(z.string()),
  direct_privs_only_2: z.array(z.string()),
});

// sec_search
export const secSearchRowSchema = z.object({
  object_type: z.string().nullable(),
  object_name: z.string(),
  module_id: z.string().nullable(),
  match_context: z.string().nullable(),
});
export const secSearchOutput = z.object({
  query: z.string(),
  object_type: z.string().nullable(),
  limit: z.number(),
  result_count: z.number(),
  truncated: z.boolean(),
  results: z.array(secSearchRowSchema),
});

// sec_stats
export const secStatsMetadataEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
});
export const secStatsOutput = z.object({
  build_info: z.array(secStatsMetadataEntrySchema),
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
  person_name: z.string().nullable(),
  required_tier: z.string().nullable(),
  monthly_cost: z.number(),
  driving_role: z.string().nullable(),
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

// ── sec_sod_check ───────────────────────────────────────────────────────────

export const secSodViolationSchema = z.object({
  rule_id: z.string(),
  rule_name: z.string(),
  risk_level: z.string(),
  category: z.string(),
  // Present for rules sourced from the D365 SoD export (not the JSON ruleset).
  severity: z.string().optional(),
  risk: z.string().optional(),
  mitigation: z.string().optional(),
  group_a_name: z.string(),
  group_a_matched: z.array(z.string()),
  group_a_roles: z.array(z.string()),
  group_b_name: z.string(),
  group_b_matched: z.array(z.string()),
  group_b_roles: z.array(z.string()),
});
export const secSodCheckOutput = z.object({
  user_id: z.string().nullable(),
  mode: z.enum(['single', 'all']),
  user_count: z.number(),
  violation_count: z.number(),
  risk_score: z.number(),
  users_with_violations: z.number(),
  violations: z.array(z.object({
    user_id: z.string(),
    person_name: z.string().nullable(),
    violation_count: z.number(),
    risk_score: z.number(),
    violations: z.array(secSodViolationSchema),
  })),
});

// ── sec_what_if ─────────────────────────────────────────────────────────────

export const secWhatIfOutput = z.object({
  user_id: z.string(),
  person_name: z.string().nullable(),
  add_roles: z.array(z.string()),
  remove_roles: z.array(z.string()),
  current_tier: z.string().nullable(),
  current_monthly_cost: z.number(),
  projected_tier: z.string().nullable(),
  projected_monthly_cost: z.number(),
  monthly_delta: z.number(),
  annual_delta: z.number(),
  current_role_count: z.number(),
  projected_role_count: z.number(),
  current_roles: z.array(z.string()),
  projected_roles: z.array(z.string()),
  sod_current_violations: z.number(),
  sod_projected_violations: z.number(),
  sod_new: z.array(secSodViolationSchema),
  sod_resolved: z.array(secSodViolationSchema),
  warnings: z.array(z.string()),
});

// ── sec_object_access ───────────────────────────────────────────────────────

export const secObjectAccessPathSchema = z.object({
  role_name: z.string(),
  permission_type: z.string().nullable(),
  duty_id: z.string().nullable(),
  privilege_name: z.string(),
  entry_point_name: z.string(),
  object_type: z.string().nullable(),
  grant_read: z.string().nullable(),
  grant_create: z.string().nullable(),
  grant_update: z.string().nullable(),
  grant_delete: z.string().nullable(),
  grant_correct: z.string().nullable(),
  grant_invoke: z.string().nullable(),
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
    person_name: z.string().nullable(),
    role_name: z.string(),
  })),
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
  last_modified: z.string().nullable(),
});

export const wikiListPageSchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  tags: z.array(z.string()),
  last_modified: z.string().nullable(),
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
  last_modified: z.string().nullable(),
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

export const taskrecorderDocStepSchema = z.object({
  step: z.number().describe('1-based step number in recording order.'),
  source: z.string().describe('Origin of the step: "client" (browser repro XML), "word" (.docx), or "recording" (.axtr only).'),
  docx_text: z.string().nullable().describe('Step text from the Word document, if a .docx was supplied.'),
  description: z.string().nullable().describe('Effective step description (client action / custom > localized > recorded).'),
  action_type: z.string().nullable().describe('Action type: client kind (navigate/click/edit/error/...) or .axtr node type.'),
  target: z.string().nullable().describe('Human-readable target, e.g. "Command: RequestClose (form SysAADClientTable)".'),
  global_id: z.string().nullable().describe('Stable GlobalId (.axtr) or step id (client recording).'),
  object_name: z.string().nullable().describe('AOT object the step touched (form or menu item) — the join key to BPM security.'),
  screenshot_count: z.number().describe('Number of screenshots embedded for this step in the MHTML.'),
  has_security: z.boolean().describe('True when the BPM package had a security block for this step\'s object.'),
  matched_action_count: z.number().describe('For client steps: how many server (.axtr) actions correlate to this step.'),
  texts_agree: z.boolean().describe('True when the Word step text matches the recorded description (false flags a mismatch).'),
});

export const taskrecorderClientRecordingSchema = z.object({
  session_id: z.string().nullable(),
  title: z.string().nullable(),
  host: z.string().nullable(),
  tenant: z.string().nullable(),
  company: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  step_count: z.number(),
  screenshot_count: z.number(),
  matched_step_count: z.number(),
}).describe('Metadata of the browser-side client repro recording, when one was supplied.');

export const taskrecorderDocFormSchema = z.object({
  form_name: z.string().describe('AOT form name that was enriched from the KB.'),
  kb_available: z.boolean().describe('False when the KB database was not configured/present.'),
  kb_found: z.boolean().describe('True when the form exists in the KB snapshot.'),
  class_count: z.number().describe('Number of related classes documented for the form.'),
  endpoint_count: z.number().describe('Number of OData/data-entity endpoints documented for the form.'),
});

export const taskrecorderDocRoleSchema = z.object({
  queried: z.string().describe('The BPM role identifier looked up (AOT name or DMF GUID).'),
  role_name: z.string().nullable().describe('Resolved role display name, or null when not found.'),
  found: z.boolean().describe('True when the role exists in the Security snapshot.'),
  sub_role_count: z.number().describe('Direct sub-roles of this role.'),
  duty_count: z.number().describe('Duties granted across the role and its sub-roles (capped).'),
  privilege_count: z.number().describe('Distinct privileges granted (capped).'),
  user_count: z.number().describe('Total users assigned to this role (full count, not the truncated list).'),
});

export const taskrecorderDocumentOutput = z.object({
  recording: z.object({
    name: z.string(),
    description: z.string().nullable(),
    canonical_id: z.string().nullable(),
    version: z.string().nullable(),
    language: z.string().nullable(),
    action_count: z.number(),
  }).describe('Functional metadata about the recording.'),
  step_count: z.number().describe('Number of documented steps (client repro steps, or .axtr actions/Word steps).'),
  screenshot_count: z.number().describe('Total screenshots embedded in the document.'),
  screenshots_present: z.boolean().describe('True when at least one screenshot was embedded.'),
  client_recording: taskrecorderClientRecordingSchema.nullable().describe('Client repro recording metadata, or null when none was supplied.'),
  steps: z.array(taskrecorderDocStepSchema).describe('Per-step mapping summary (client step ↔ server .axtr action ↔ BPM security).'),
  forms_enriched: z.array(taskrecorderDocFormSchema).describe('KB enrichment summary, one entry per distinct form/object.'),
  roles_enriched: z.array(taskrecorderDocRoleSchema).describe('Security enrichment summary, one entry per distinct BPM role.'),
  bpm_role_count: z.number().describe('Distinct role/duty/privilege grants found in the BPM package.'),
  kb_available: z.boolean().describe('True when KB enrichment ran (KB_DB_PATH present).'),
  sec_available: z.boolean().describe('True when Security enrichment ran (SEC_DB_PATH present).'),
  output_path: z.string().nullable().describe('Absolute path the .mhtml was written to — open this file to view the document.'),
  byte_size: z.number().describe('Size of the generated MHTML document in bytes.'),
  document_mhtml: z.string().nullable().describe('The full MHTML text, present only when return_inline=true; otherwise null.'),
  xml_output_path: z.string().nullable().describe('Absolute path the contract XML was written to (when include_xml=true), else null. Validates against schemas/task-recording-document.xsd.'),
  document_xml: z.string().nullable().describe('The full contract XML text, present only when include_xml=true AND return_inline=true; otherwise null.'),
  notes: z.array(z.string()).describe('Warnings/observations, e.g. "no screenshots embedded" or "KB database not available".'),
});

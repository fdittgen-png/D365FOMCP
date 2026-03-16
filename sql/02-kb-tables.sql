-- ═══════════════════════════════════════════════════════════
--  D365FO MCP Services — KB Schema Tables
-- ═══════════════════════════════════════════════════════════

CREATE TABLE kb.kb_metadata (
  [key] NVARCHAR(100) PRIMARY KEY,
  [value] NVARCHAR(MAX)
);

CREATE TABLE kb.modules (
  module_id NVARCHAR(200) PRIMARY KEY,
  table_count INT DEFAULT 0,
  class_count INT DEFAULT 0,
  enum_count INT DEFAULT 0,
  entity_count INT DEFAULT 0,
  form_count INT DEFAULT 0
);

CREATE TABLE kb.tables (
  table_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  table_group NVARCHAR(100),
  save_per_company NVARCHAR(10) DEFAULT 'Yes',
  cache_lookup NVARCHAR(100),
  clustered_index NVARCHAR(200),
  replacement_key NVARCHAR(200),
  config_key NVARCHAR(200),
  field_count INT DEFAULT 0,
  has_methods BIT DEFAULT 0,
  developer_doc NVARCHAR(MAX),
  file_path NVARCHAR(500)
);

CREATE TABLE kb.fields (
  table_name NVARCHAR(200) NOT NULL,
  field_name NVARCHAR(200) NOT NULL,
  field_type NVARCHAR(100),
  edt NVARCHAR(200),
  enum_type NVARCHAR(200),
  mandatory NVARCHAR(10) DEFAULT 'No',
  allow_edit NVARCHAR(10) DEFAULT 'Yes',
  label NVARCHAR(500),
  CONSTRAINT PK_kb_fields PRIMARY KEY (table_name, field_name)
);

CREATE TABLE kb.indexes_tbl (
  table_name NVARCHAR(200) NOT NULL,
  index_name NVARCHAR(200) NOT NULL,
  is_unique BIT DEFAULT 0,
  is_clustered BIT DEFAULT 0,
  fields_json NVARCHAR(MAX),
  CONSTRAINT PK_kb_indexes PRIMARY KEY (table_name, index_name)
);

CREATE TABLE kb.relations (
  source_table NVARCHAR(200) NOT NULL,
  relation_name NVARCHAR(200) NOT NULL,
  related_table NVARCHAR(200),
  cardinality NVARCHAR(50),
  related_cardinality NVARCHAR(50),
  on_delete NVARCHAR(50),
  relationship_type NVARCHAR(100),
  constraints_json NVARCHAR(MAX),
  CONSTRAINT PK_kb_relations PRIMARY KEY (source_table, relation_name)
);

CREATE TABLE kb.enums (
  enum_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  values_json NVARCHAR(MAX)
);

CREATE TABLE kb.edts (
  edt_name NVARCHAR(200) PRIMARY KEY,
  base_type NVARCHAR(100),
  extends_edt NVARCHAR(200),
  label NVARCHAR(500),
  string_size INT,
  table_ref NVARCHAR(200),
  module_id NVARCHAR(200)
);

CREATE TABLE kb.classes (
  class_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  extends_class NVARCHAR(200),
  implements_list NVARCHAR(500),
  is_abstract BIT DEFAULT 0,
  method_count INT DEFAULT 0,
  file_path NVARCHAR(500)
);

CREATE TABLE kb.methods (
  owner_type NVARCHAR(20) NOT NULL,
  owner_name NVARCHAR(200) NOT NULL,
  method_name NVARCHAR(200) NOT NULL,
  signature NVARCHAR(500),
  is_static BIT DEFAULT 0,
  source_code NVARCHAR(MAX),
  CONSTRAINT PK_kb_methods PRIMARY KEY (owner_type, owner_name, method_name)
);

CREATE TABLE kb.data_entities (
  entity_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  public_name NVARCHAR(200),
  public_collection NVARCHAR(200),
  is_public BIT DEFAULT 0,
  primary_table NVARCHAR(200),
  staging_table NVARCHAR(200),
  config_key NVARCHAR(200),
  file_path NVARCHAR(500)
);

CREATE TABLE kb.entity_fields (
  entity_name NVARCHAR(200) NOT NULL,
  field_name NVARCHAR(200) NOT NULL,
  data_field NVARCHAR(200),
  data_source NVARCHAR(200),
  is_mandatory BIT DEFAULT 0,
  CONSTRAINT PK_kb_entity_fields PRIMARY KEY (entity_name, field_name)
);

CREATE TABLE kb.forms (
  form_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  data_sources_json NVARCHAR(MAX),
  file_path NVARCHAR(500)
);

CREATE TABLE kb.views (
  view_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  config_key NVARCHAR(200),
  field_count INT DEFAULT 0,
  file_path NVARCHAR(500)
);

CREATE TABLE kb.security_roles (
  role_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  description NVARCHAR(MAX),
  duties_json NVARCHAR(MAX)
);

CREATE TABLE kb.security_duties (
  duty_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  description NVARCHAR(MAX),
  privileges_json NVARCHAR(MAX)
);

CREATE TABLE kb.security_privileges (
  privilege_name NVARCHAR(200) PRIMARY KEY,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  entry_points_json NVARCHAR(MAX)
);

CREATE TABLE kb.menu_items (
  menu_item_name NVARCHAR(200) NOT NULL,
  menu_item_type NVARCHAR(50) NOT NULL,
  module_id NVARCHAR(200),
  label NVARCHAR(500),
  object_name NVARCHAR(200),
  object_type NVARCHAR(100),
  config_key NVARCHAR(200),
  CONSTRAINT PK_kb_menu_items PRIMARY KEY (menu_item_name, menu_item_type)
);

CREATE TABLE kb.graph_edges (
  source_node NVARCHAR(200) NOT NULL,
  source_type NVARCHAR(50),
  target_node NVARCHAR(200) NOT NULL,
  target_type NVARCHAR(50),
  edge_type NVARCHAR(50) NOT NULL,
  edge_detail NVARCHAR(500) NOT NULL,
  CONSTRAINT PK_kb_graph_edges PRIMARY KEY (source_node, target_node, edge_type, edge_detail)
);

CREATE TABLE kb.kb_search (
  id INT IDENTITY(1,1) PRIMARY KEY,
  object_type NVARCHAR(50),
  object_name NVARCHAR(200),
  module_id NVARCHAR(200),
  content NVARCHAR(MAX)
);

CREATE TABLE kb.hallucination_traps (
  trap_id INT IDENTITY(1,1) PRIMARY KEY,
  object_name NVARCHAR(200),
  trap_type NVARCHAR(100),
  wrong_value NVARCHAR(200),
  correct_value NVARCHAR(200),
  explanation NVARCHAR(MAX)
);

CREATE TABLE kb.field_renames (
  table_name NVARCHAR(200) NOT NULL,
  ax2012_name NVARCHAR(200) NOT NULL,
  d365fo_name NVARCHAR(200),
  CONSTRAINT PK_kb_field_renames PRIMARY KEY (table_name, ax2012_name)
);

CREATE TABLE kb.query_templates (
  template_id INT IDENTITY(1,1) PRIMARY KEY,
  title NVARCHAR(200),
  description NVARCHAR(MAX),
  sql_template NVARCHAR(MAX),
  tables_used NVARCHAR(500)
);

CREATE TABLE kb.object_paths (
  object_type NVARCHAR(50) NOT NULL,
  object_name NVARCHAR(200) NOT NULL,
  file_path NVARCHAR(500),
  file_size INT,
  CONSTRAINT PK_kb_object_paths PRIMARY KEY (object_type, object_name)
);
GO

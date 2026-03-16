-- ═══════════════════════════════════════════════════════════
--  D365FO MCP Services — Indexes
-- ═══════════════════════════════════════════════════════════

-- KB Indexes
CREATE INDEX IX_kb_fields_table ON kb.fields (table_name);
CREATE INDEX IX_kb_relations_source ON kb.relations (source_table);
CREATE INDEX IX_kb_relations_target ON kb.relations (related_table);
CREATE INDEX IX_kb_methods_owner ON kb.methods (owner_type, owner_name);
CREATE INDEX IX_kb_classes_extends ON kb.classes (extends_class);
CREATE INDEX IX_kb_classes_module ON kb.classes (module_id);
CREATE INDEX IX_kb_tables_module ON kb.tables (module_id);
CREATE INDEX IX_kb_graph_source ON kb.graph_edges (source_node);
CREATE INDEX IX_kb_graph_target ON kb.graph_edges (target_node);
CREATE INDEX IX_kb_entity_fields ON kb.entity_fields (entity_name);
CREATE INDEX IX_kb_search_name ON kb.kb_search (object_name);
CREATE INDEX IX_kb_search_type ON kb.kb_search (object_type);

-- XRef Indexes
CREATE INDEX IX_xref_names_path ON xref.names (path);
CREATE INDEX IX_xref_names_module ON xref.names (module_id);
CREATE INDEX IX_xref_refs_target ON xref.refs (target_id);
CREATE INDEX IX_xref_refs_kind ON xref.refs (kind);
CREATE INDEX IX_xref_refs_source_kind ON xref.refs (source_id, kind);
CREATE INDEX IX_xref_refs_target_kind ON xref.refs (target_id, kind);
CREATE INDEX IX_xref_modules_module ON xref.modules (module);
GO

-- ═══════════════════════════════════════════════════════════
--  D365FO MCP Services — Full-Text Search Indexes
--  (Unlocks code search not possible with SQLite/sql.js)
-- ═══════════════════════════════════════════════════════════

CREATE FULLTEXT CATALOG ftcat_mcpd365fo AS DEFAULT;
GO

-- Full-text on method source code + signatures
CREATE FULLTEXT INDEX ON kb.methods (source_code, signature)
  KEY INDEX PK_kb_methods ON ftcat_mcpd365fo
  WITH STOPLIST = OFF;
GO

-- Full-text on search content
CREATE FULLTEXT INDEX ON kb.kb_search (content, object_name)
  KEY INDEX [PK__kb_searc__3213E83F_placeholder] ON ftcat_mcpd365fo
  WITH STOPLIST = OFF;
GO

-- Note: The PK index name for kb_search will be auto-generated.
-- Replace placeholder above with actual index name after table creation.
-- Query: SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('kb.kb_search') AND is_primary_key = 1

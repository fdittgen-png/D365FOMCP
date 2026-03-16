-- ═══════════════════════════════════════════════════════════
--  D365FO MCP Services — XRef Schema Tables
-- ═══════════════════════════════════════════════════════════

CREATE TABLE xref.names (
  id INT PRIMARY KEY,
  path NVARCHAR(500) NOT NULL,
  provider_id INT NOT NULL,
  module_id INT NOT NULL
);

CREATE TABLE xref.refs (
  source_id INT NOT NULL,
  target_id INT NOT NULL,
  kind INT NOT NULL,
  line INT,
  col INT
);

-- Clustered index on refs for optimal join performance
CREATE CLUSTERED INDEX IX_xref_refs_clustered
  ON xref.refs (source_id, target_id);

CREATE TABLE xref.modules (
  id INT PRIMARY KEY,
  module NVARCHAR(200) NOT NULL
);

CREATE TABLE xref.providers (
  id INT PRIMARY KEY,
  provider NVARCHAR(100) NOT NULL
);

CREATE TABLE xref.kind_map (
  id INT PRIMARY KEY,
  name NVARCHAR(50) NOT NULL
);

CREATE TABLE xref.xref_metadata (
  [key] NVARCHAR(100) PRIMARY KEY,
  [value] NVARCHAR(MAX)
);
GO

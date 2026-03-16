-- ═══════════════════════════════════════════════════════════
--  D365FO MCP Services — Schema Creation
--  Database: tis-{env}-mcpd365fo-sqldb
-- ═══════════════════════════════════════════════════════════

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'kb')
    EXEC('CREATE SCHEMA kb');
GO

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'xref')
    EXEC('CREATE SCHEMA xref');
GO

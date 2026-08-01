-- FlowForge Postgres Row-Level Security policies.
-- Apply AFTER Drizzle migrations create the base tables.
--
-- Per-request, the runtime sets:
--   SET LOCAL flowforge.tenant_id = '<tenant uuid>';
--   SET LOCAL flowforge.user_id   = '<user uuid>';
--
-- Every read/write is then automatically filtered to the calling tenant.
-- Cross-tenant access requires explicitly setting a superuser role.

-- 1. Enable RLS on every tenanted table
ALTER TABLE workflows   ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE users       ENABLE ROW LEVEL SECURITY;

-- 2. Force RLS even for table owner (defence in depth — prevents migrations
--    accidentally leaking cross-tenant data)
ALTER TABLE workflows   FORCE ROW LEVEL SECURITY;
ALTER TABLE runs        FORCE ROW LEVEL SECURITY;
ALTER TABLE credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log   FORCE ROW LEVEL SECURITY;
ALTER TABLE users       FORCE ROW LEVEL SECURITY;

-- 3. Policies — tenant_id MUST match the GUC set by the connection middleware
CREATE POLICY tenant_isolation_workflows ON workflows
  USING (tenant_id::text = current_setting('flowforge.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('flowforge.tenant_id', true));

CREATE POLICY tenant_isolation_runs ON runs
  USING (tenant_id::text = current_setting('flowforge.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('flowforge.tenant_id', true));

CREATE POLICY tenant_isolation_credentials ON credentials
  USING (tenant_id::text = current_setting('flowforge.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('flowforge.tenant_id', true));

CREATE POLICY tenant_isolation_audit_log ON audit_log
  USING (tenant_id::text = current_setting('flowforge.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('flowforge.tenant_id', true));

CREATE POLICY tenant_isolation_users ON users
  USING (tenant_id::text = current_setting('flowforge.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('flowforge.tenant_id', true));

-- 4. Indexes critical for RLS scans
CREATE INDEX IF NOT EXISTS workflows_tenant_isolation_idx   ON workflows(tenant_id);
CREATE INDEX IF NOT EXISTS runs_tenant_isolation_idx        ON runs(tenant_id);
CREATE INDEX IF NOT EXISTS credentials_tenant_isolation_idx ON credentials(tenant_id);
CREATE INDEX IF NOT EXISTS audit_log_tenant_isolation_idx   ON audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS users_tenant_isolation_idx       ON users(tenant_id);

-- 5. Roles
--    flowforge_app   — the role the runtime connects as. Has DML on every
--                      tenanted table but enforced by RLS.
--    flowforge_admin — bypass for migrations and break-glass operations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowforge_app') THEN
    CREATE ROLE flowforge_app NOINHERIT NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowforge_admin') THEN
    CREATE ROLE flowforge_admin NOINHERIT NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flowforge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flowforge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowforge_app;

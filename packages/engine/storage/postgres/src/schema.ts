import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  bigint,
  index,
  uuid,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settingsJson: jsonb('settings_json'),
  },
  (table) => ({ slugIdx: index('tenants_slug_idx').on(table.slug) }),
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['owner', 'editor', 'operator', 'viewer'] }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (table) => ({
    tenantEmailIdx: index('users_tenant_email_idx').on(table.tenantId, table.email),
  }),
);

export const workflows = pgTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(false),
    schemaVersion: text('schema_version').notNull().default('1.0.0'),
    nodesJson: jsonb('nodes_json').notNull().default([]),
    edgesJson: jsonb('edges_json').notNull().default([]),
    nodeDefsJson: jsonb('node_defs_json').notNull().default([]),
    breakpointsJson: jsonb('breakpoints_json'),
    tagsJson: jsonb('tags_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    ownerId: uuid('owner_id'),
  },
  (table) => ({
    tenantIdx: index('workflows_tenant_idx').on(table.tenantId),
  }),
);

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['pending', 'running', 'success', 'error', 'paused', 'cancelled'],
    }).notNull(),
    triggerType: text('trigger_type'),
    triggerPayloadJson: jsonb('trigger_payload_json'),
    input: text('input').notNull().default(''),
    stepsJson: jsonb('steps_json').notNull().default([]),
    pausedJson: jsonb('paused_json'),
    errorCount: integer('error_count').notNull().default(0),
    totalDurationMs: integer('total_duration_ms'),
    triggeredBy: uuid('triggered_by'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => ({
    workflowIdx: index('runs_workflow_idx').on(table.workflowId),
    tenantIdx: index('runs_tenant_idx').on(table.tenantId),
  }),
);

export const credentials = pgTable('credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  ciphertext: text('ciphertext').notNull(),
  nonce: text('nonce').notNull(),
  metadataJson: jsonb('metadata_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  metadataJson: jsonb('metadata_json'),
  prevHash: text('prev_hash'),
  hash: text('hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const usersRelations = relations(users, ({ one }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id] }),
}));

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  tenant: one(tenants, { fields: [workflows.tenantId], references: [tenants.id] }),
  runs: many(runs),
}));

export const runsRelations = relations(runs, ({ one }) => ({
  workflow: one(workflows, { fields: [runs.workflowId], references: [workflows.id] }),
  tenant: one(tenants, { fields: [runs.tenantId], references: [tenants.id] }),
}));

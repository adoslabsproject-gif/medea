import { z } from 'zod';
import { NodeDefSchema, type NodeDef } from '@medea/engine-core-schema';
import type { NodeModule, NodeExecutor } from '@medea/engine-nodes-stdlib';

/**
 * @medea/engine-nodes-sdk — public SDK for building community connectors.
 *
 * Typical usage (in a community connector package):
 *
 *   import { defineNode } from '@medea/engine-nodes-sdk';
 *
 *   export default defineNode({
 *     id: 'action_my_custom',
 *     type: 'action',
 *     label: 'My Custom Node',
 *     icon: 'box',
 *     color: '#123456',
 *     description: '…',
 *     configFields: [...],
 *     async execute(config, input, context) { ... return { output, durationMs }; }
 *   });
 */

export const NodeManifestSchema = z.object({
  name: z.string().regex(/^@?[a-z0-9-]+\/[a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.-]+)?$/),
  author: z.object({
    name: z.string(),
    email: z.string().email().optional(),
    url: z.string().url().optional(),
  }),
  license: z.string().default('MIT'),
  flowforgeApiVersion: z.string().regex(/^\d+\.\d+$/),
  nodes: z.array(z.string()),
  signature: z.string().optional(),
});
export type NodeManifest = z.infer<typeof NodeManifestSchema>;

export interface DefineNodeInput extends NodeDef {
  execute?: NodeExecutor;
}

export function defineNode(input: DefineNodeInput): NodeModule {
  const { execute, ...defOnly } = input;
  const validated = NodeDefSchema.parse(defOnly);
  const module: NodeModule = { def: validated };
  if (execute) module.executor = execute;
  return module;
}

export function defineNodes(...inputs: DefineNodeInput[]): NodeModule[] {
  return inputs.map(defineNode);
}

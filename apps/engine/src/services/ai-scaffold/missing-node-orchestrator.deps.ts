/**
 * Wire deps reali per missing-node-orchestrator.
 *
 * Connette i punti di pure logic dell'orchestrator alle implementazioni
 * concrete:
 *  - generateNodeBlueprint → callAiAssist({ action: 'generate' }) Liara
 *  - persistAndPublish     → createCustomNode + publishCustomNodePrivate
 *  - findExistingCustomDefId → getCustomNodeBySlug + customNodeDefId
 *
 * Tenuto separato dal modulo pure per testability + cost-isolation: i test
 * del modulo non istanziano DB/LLM; questo file e\` un thin glue.
 */

import { callAiAssist } from '../custom-nodes/ai-assist.js';
import {
  compileAndPersist,
  createCustomNode,
  customNodeDefId,
  getCustomNodeBySlug,
  publishCustomNodePrivate,
} from '../custom-nodes/index.js';
import type {
  OrchestratorDeps,
  PlanItem,
  SynthesizedBlueprint,
  PersistAndPublishInput,
  PersistAndPublishOutput,
} from './missing-node-orchestrator.js';

/**
 * Builder: ritorna deps wired alle implementazioni reali, con workspaceId
 * fissato (necessario per ai-assist auth gateway).
 */
export function buildRealOrchestratorDeps(workspaceId: string): OrchestratorDeps {
  return {
    async findExistingCustomDefId(ws: string, slug: string): Promise<string | null> {
      const existing = await getCustomNodeBySlug({ workspaceId: ws, slug });
      return existing ? customNodeDefId(existing.slug) : null;
    },

    async generateNodeBlueprint(item: PlanItem): Promise<SynthesizedBlueprint> {
      const response = await callAiAssist({
        action: 'generate',
        prompt: item.llmPrompt,
        workspaceId,
      });
      const patch = response.patch;
      if (!patch?.executor || !patch.definition || !patch.schema) {
        throw new Error(
          `LLM blueprint incompleto: ${
            !patch?.executor ? 'manca executor ' : ''
          }${!patch?.definition ? 'manca definition ' : ''}${!patch?.schema ? 'manca schema' : ''}`.trim(),
        );
      }
      return {
        sourceExecutor: patch.executor,
        sourceDefinition: patch.definition,
        sourceSchema: patch.schema,
      };
    },

    async persistAndPublish(input: PersistAndPublishInput): Promise<PersistAndPublishOutput> {
      const created = await createCustomNode({
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
        input: {
          slug: input.slug,
          displayName: input.displayName,
          description: input.description,
          sourceExecutor: input.blueprint.sourceExecutor,
          sourceDefinition: input.blueprint.sourceDefinition,
          sourceSchema: input.blueprint.sourceSchema,
        },
      });
      // Compile (esbuild) → richiesto da publish per popolare compiledExecutor.
      await compileAndPersist({
        workspaceId: input.workspaceId,
        id: created.id,
        sources: {
          executor: input.blueprint.sourceExecutor,
          definition: input.blueprint.sourceDefinition,
          schema: input.blueprint.sourceSchema,
        },
      });
      await publishCustomNodePrivate({
        workspaceId: input.workspaceId,
        id: created.id,
        actorUserId: input.ownerUserId,
      });
      return {
        defId: customNodeDefId(created.slug),
        customNodeId: created.id,
        semver: created.semver,
      };
    },
  };
}

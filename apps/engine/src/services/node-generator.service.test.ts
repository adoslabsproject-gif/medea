/**
 * Test 2026-grade — NodeGeneratorService (AI scaffold + safety gate).
 *
 * SECURITY: forbidden tokens (require/eval/process.env/fs/child_process) → reject.
 * VALIDATION: NodeDefSchema + Zod payload schema enforced.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@medea/engine-core-schema', async () => {
  const { z } = await import('zod');
  return {
    NodeDefSchema: z.object({
      id: z.string(),
      type: z.string(),
      label: z.string(),
    }),
  };
});

import { NodeGeneratorService } from './node-generator.service.js';

function makeLlm(text: string): any {
  return { complete: vi.fn().mockResolvedValue({ text }) };
}

const validDef = { id: 'test', type: 'action', label: 'Test' };
const validResp = (overrides: any = {}) => '```json\n' + JSON.stringify({
  def: validDef,
  executorSource: 'async function execute(c, i, ctx) { return { output: 1 }; }',
  rationale: 'r',
  ...overrides,
}) + '\n```';

describe('🚨 generate — validation', () => {
  it('🚨 description < 10 char → throw', async () => {
    const svc = new NodeGeneratorService(makeLlm(''));
    await expect(svc.generate({ description: 'short' })).rejects.toThrow(/at least 10/u);
  });

  it('🚨 model passed empty (resolver-resolved upstream)', async () => {
    const llm = makeLlm(validResp());
    const svc = new NodeGeneratorService(llm);
    await svc.generate({ description: 'A long enough description for node' });
    expect(llm.complete).toHaveBeenCalledWith(expect.objectContaining({ model: '' }));
  });

  it('🚨 language=it → prompt in italiano', async () => {
    const llm = makeLlm(validResp());
    const svc = new NodeGeneratorService(llm);
    await svc.generate({ description: 'a long description here', language: 'it' });
    const msgs = (llm.complete.mock.calls[0][0]).messages;
    expect(msgs[0].content).toMatch(/Sei un esperto/u);
  });

  it('🚨 language=en default', async () => {
    const llm = makeLlm(validResp());
    const svc = new NodeGeneratorService(llm);
    await svc.generate({ description: 'a long description here' });
    const msgs = (llm.complete.mock.calls[0][0]).messages;
    expect(msgs[0].content).toMatch(/expert FlowForge node developer/u);
  });

  it('🚨 openApiUrl → riferimento nel user prompt', async () => {
    const llm = makeLlm(validResp());
    const svc = new NodeGeneratorService(llm);
    await svc.generate({ description: 'a long description here', openApiUrl: 'https://api.example.com/spec.json' });
    const msgs = (llm.complete.mock.calls[0][0]).messages;
    expect(msgs[1].content).toMatch(/spec\.json/u);
  });
});

describe('🚨 parseLLMResponse — fenced JSON extract', () => {
  it('🚨 ```json block → parse OK', () => {
    const svc = new NodeGeneratorService(makeLlm(''));
    const r = svc.parseLLMResponse(validResp());
    expect(r.def.id).toBe('test');
  });

  it('🚨 plain JSON no fence → parse OK', () => {
    const svc = new NodeGeneratorService(makeLlm(''));
    const r = svc.parseLLMResponse(JSON.stringify({
      def: validDef,
      executorSource: 'async function execute(c, i, ctx) { return { output: 1 }; }',
      rationale: 'r',
    }));
    expect(r.def.id).toBe('test');
  });

  it('🚨 invalid JSON → throw', () => {
    const svc = new NodeGeneratorService(makeLlm(''));
    expect(() => svc.parseLLMResponse('not-json{')).toThrow(/not valid JSON/u);
  });

  it('🚨 schema fail → throw con issues', () => {
    const svc = new NodeGeneratorService(makeLlm(''));
    expect(() => svc.parseLLMResponse('```json\n{"def":{}}\n```')).toThrow(/failed validation/u);
  });

  it('🚨 warnings array propagato', () => {
    const svc = new NodeGeneratorService(makeLlm(''));
    const r = svc.parseLLMResponse(validResp({
      warnings: ['rate-limit risk', 'consumes 10 tokens'],
    }));
    expect(r.warnings).toEqual(['rate-limit risk', 'consumes 10 tokens']);
  });
});

describe('🚨 SECURITY forbidden tokens', () => {
  it.each([
    { name: 'require()', code: 'async function execute(c,i,x) { const fs = require("fs"); }' },
    { name: 'eval', code: 'async function execute(c,i,x) { eval(c.code); }' },
    { name: 'process.env', code: 'async function execute(c,i,x) { console.log(process.env.SECRET); }' },
    { name: 'child_process', code: 'async function execute(c,i,x) { const cp = require("child_process"); }' },
    { name: 'fs.', code: 'async function execute(c,i,x) { fs.readFileSync("/etc/passwd"); }' },
    { name: 'new Function', code: 'async function execute(c,i,x) { new Function("return 1")(); }' },
    { name: 'globalThis', code: 'async function execute(c,i,x) { globalThis.process.exit(0); }' },
  ])('🚨 reject "$name"', ({ code }) => {
    const svc = new NodeGeneratorService(makeLlm(''));
    expect(() => svc.parseLLMResponse('```json\n' + JSON.stringify({
      def: validDef, executorSource: code, rationale: 'r',
    }) + '\n```')).toThrow(/forbidden tokens/u);
  });
});

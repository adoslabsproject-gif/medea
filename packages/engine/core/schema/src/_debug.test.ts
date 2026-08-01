import { describe, it, expect } from 'vitest';
import * as wf from './workflow.js';
import * as wfNoExt from './workflow';

describe('debug import resolution', () => {
  it('with .js ext', () => {
    console.log('keys with .js:', Object.keys(wf).sort());
    expect(wf.NodeNameSchema).toBeDefined();
  });
  it('without ext', () => {
    console.log('keys without ext:', Object.keys(wfNoExt).sort());
    expect(wfNoExt.NodeNameSchema).toBeDefined();
  });
});

/**
 * Test 2026-grade — node I/O shape catalog.
 *
 * Coverage REALE: ogni defId nelle 4 set ha shape coerente con la sua
 * categoria. Regressioni: defId aggiunti senza pensare alla shape →
 * test fail-loud invece di silent drift.
 */
import { describe, it, expect } from 'vitest';
import {
  getNodeShape,
  isArrayProducer,
  isScalarConsumer,
  isAggregator,
  isLoopBodyPassthrough,
} from './node-shape.js';

describe('getNodeShape — array producers', () => {
  const ARRAY = [
    'action_sitemap_crawler',
    'action_recursive_spider',
    'db_query',
    'action_link_audit',
    'action_streammy_search_multichannel',
    'action_streammy_catalog',
    'action_email_harvest',
    'action_paginate',
    'action_distinct',
    'action_group_by',
  ];

  it.each(ARRAY)('%s emette array', (defId) => {
    expect(getNodeShape(defId).output).toBe('array');
    expect(isArrayProducer(defId)).toBe(true);
  });
});

describe('getNodeShape — scalar consumers', () => {
  const SCALAR = [
    'action_seo_audit',
    'action_meta_extract',
    'action_redirect_chain',
    'action_keyword_density',
    'action_http',
    'action_stealth_browser',
    'agent_extractor',
    'agent_classifier',
    'agent_validator',
    'db_insert',
    'db_update',
    'db_delete',
    'action_file_write',
    'action_pdf_render',
    'action_pec_legal_archive',
  ];

  it.each(SCALAR)('%s consuma scalar', (defId) => {
    expect(getNodeShape(defId).input).toBe('scalar');
    expect(isScalarConsumer(defId)).toBe(true);
  });
});

describe('getNodeShape — aggregators', () => {
  const AGGR = [
    'agent_data_analyst',
    'agent_summarizer',
    'action_aggregate',
    'flow_merge',
    'logic_join',
    'action_iptv_m3u',
    'action_vlc_playlist',
    'action_catalog_page',
  ];

  it.each(AGGR)('%s accetta multi-input', (defId) => {
    expect(getNodeShape(defId).input).toBe('multi');
    expect(isAggregator(defId)).toBe(true);
  });
});

describe('getNodeShape — loop-body passthrough', () => {
  it('logic_loop e\\` riconosciuto come iterator', () => {
    expect(isLoopBodyPassthrough('logic_loop')).toBe(true);
    expect(getNodeShape('logic_loop').input).toBe('array');
    expect(getNodeShape('logic_loop').output).toBe('array');
  });
});

describe('getNodeShape — unknown nodes', () => {
  it('community_telegram non classificato → unknown/unknown (no-false-positive)', () => {
    expect(getNodeShape('community_telegram')).toEqual({ input: 'unknown', output: 'unknown' });
  });

  it('defId sconosciuto → unknown/unknown', () => {
    expect(getNodeShape('definitely_does_not_exist')).toEqual({
      input: 'unknown',
      output: 'unknown',
    });
  });

  it('isArrayProducer/isScalarConsumer/isAggregator false su unknown', () => {
    expect(isArrayProducer('community_telegram')).toBe(false);
    expect(isScalarConsumer('community_telegram')).toBe(false);
    expect(isAggregator('community_telegram')).toBe(false);
  });
});

describe('getNodeShape — overlap edge cases', () => {
  it('action_iptv_m3u è sia array producer (output) che aggregator (input)', () => {
    expect(isArrayProducer('action_iptv_m3u')).toBe(true);
    expect(isAggregator('action_iptv_m3u')).toBe(true);
    const s = getNodeShape('action_iptv_m3u');
    expect(s.output).toBe('array');
    expect(s.input).toBe('multi');
  });
});

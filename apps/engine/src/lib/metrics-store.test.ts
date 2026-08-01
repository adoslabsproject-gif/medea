/**
 * MetricsStore — unit tests for the in-process Prometheus-style counters,
 * histograms and gauges.
 *
 * Focus: format correctness (the lines we emit MUST parse cleanly with
 * prom-text-format), tag-key uniqueness, and histogram bucket semantics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  counterInc,
  histogramObserve,
  gaugeSet,
  renderPrometheus,
  _resetMetrics,
} from './metrics-store.js';

beforeEach(() => { _resetMetrics(); });

describe('counterInc', () => {
  it('starts at 1 on first call, increments on subsequent', () => {
    counterInc({ name: 'foo', help: 'foo help' });
    counterInc({ name: 'foo', help: 'foo help' });
    counterInc({ name: 'foo', help: 'foo help' });
    expect(renderPrometheus()).toMatch(/foo 3/);
  });

  it('keeps distinct counters per tag combination', () => {
    counterInc({ name: 'calls', help: 'calls', tags: { provider: 'a' } });
    counterInc({ name: 'calls', help: 'calls', tags: { provider: 'b' } });
    counterInc({ name: 'calls', help: 'calls', tags: { provider: 'a' } });
    const out = renderPrometheus();
    expect(out).toMatch(/calls\{provider="a"\} 2/);
    expect(out).toMatch(/calls\{provider="b"\} 1/);
  });

  it('supports custom increment amount', () => {
    counterInc({ name: 'bytes', help: 'bytes seen', amount: 1024 });
    counterInc({ name: 'bytes', help: 'bytes seen', amount: 512 });
    expect(renderPrometheus()).toMatch(/bytes 1536/);
  });
});

describe('histogramObserve', () => {
  it('emits bucket counts + sum + count in Prometheus format', () => {
    histogramObserve({ name: 'lat_ms', help: 'lat', value: 80 });
    histogramObserve({ name: 'lat_ms', help: 'lat', value: 200 });
    histogramObserve({ name: 'lat_ms', help: 'lat', value: 800 });
    const out = renderPrometheus();
    expect(out).toMatch(/# TYPE lat_ms histogram/);
    expect(out).toMatch(/lat_ms_bucket\{le="100"\} 1/);
    expect(out).toMatch(/lat_ms_bucket\{le="250"\} 2/);
    expect(out).toMatch(/lat_ms_bucket\{le="1000"\} 3/);
    expect(out).toMatch(/lat_ms_bucket\{le="\+Inf"\} 3/);
    expect(out).toMatch(/lat_ms_sum 1080/);
    expect(out).toMatch(/lat_ms_count 3/);
  });
});

describe('gaugeSet', () => {
  it('sets to the absolute value (overwrites prior)', () => {
    gaugeSet({ name: 'queue_depth', help: 'q', value: 5 });
    gaugeSet({ name: 'queue_depth', help: 'q', value: 12 });
    expect(renderPrometheus()).toMatch(/queue_depth 12/);
  });
});

describe('renderPrometheus', () => {
  it('emits a single # HELP and # TYPE per metric name (even with multiple tag sets)', () => {
    counterInc({ name: 'calls', help: 'total calls', tags: { provider: 'a' } });
    counterInc({ name: 'calls', help: 'total calls', tags: { provider: 'b' } });
    const out = renderPrometheus();
    expect((out.match(/# HELP calls/g) ?? []).length).toBe(1);
    expect((out.match(/# TYPE calls counter/g) ?? []).length).toBe(1);
  });

  it('returns empty string when no metrics registered', () => {
    expect(renderPrometheus()).toBe('');
  });
});

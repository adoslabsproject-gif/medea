/**
 * Lightweight in-process Prometheus-compatible metrics store.
 *
 * We avoid `prom-client` (yet) to keep the dependency surface minimal — it
 * pulls a fair amount of code for what is currently a handful of counters.
 * When metric volume grows, swap this for prom-client without changing the
 * call sites: the public API (counterInc / histogramObserve) stays.
 *
 * Three primitive types are enough for our needs today:
 *   • Counter   — monotonically-increasing total (calls, errors)
 *   • Histogram — for latency distributions; we use fixed buckets in ms
 *   • Gauge     — current values that go up & down (cached items, queue depth)
 *
 * Each metric has a tag-set for cardinality. Keep tag values bounded — never
 * tag by user_id or workflow_id (high-cardinality → memory blowup).
 */

interface CounterEntry {
  value: number;
  help: string;
  type: 'counter';
}
interface HistogramEntry {
  sum: number;
  count: number;
  buckets: number[];
  bucketCounts: number[];
  help: string;
  type: 'histogram';
}
interface GaugeEntry {
  value: number;
  help: string;
  type: 'gauge';
}
type Entry = CounterEntry | HistogramEntry | GaugeEntry;

const STORE = new Map<string, Entry>();

/** Default latency buckets in ms. Covers ~50ms-30s, fits LLM call distribution. */
const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];

function tagsToKey(name: string, tags: Record<string, string> = {}): string {
  const sortedTags = Object.keys(tags)
    .sort()
    .map((k) => `${k}="${tags[k]!.replace(/"/g, '\\"')}"`)
    .join(',');
  return sortedTags.length > 0 ? `${name}{${sortedTags}}` : name;
}

/**
 * Increment a counter by 1 (or by the given amount).
 * Idempotent on first-call: counter is created lazily with help text.
 */
export function counterInc(args: {
  name: string;
  help: string;
  tags?: Record<string, string>;
  amount?: number;
}): void {
  const key = tagsToKey(args.name, args.tags);
  const existing = STORE.get(key);
  if (existing?.type === 'counter') {
    existing.value += args.amount ?? 1;
    return;
  }
  STORE.set(key, { type: 'counter', value: args.amount ?? 1, help: args.help });
}

/** Observe a latency value (ms) for a histogram. */
export function histogramObserve(args: {
  name: string;
  help: string;
  tags?: Record<string, string>;
  value: number;
}): void {
  const key = tagsToKey(args.name, args.tags);
  const existing = STORE.get(key);
  if (existing?.type === 'histogram') {
    existing.sum += args.value;
    existing.count += 1;
    for (let i = 0; i < existing.buckets.length; i += 1) {
      if (args.value <= existing.buckets[i]!) existing.bucketCounts[i]! += 1;
    }
    return;
  }
  const bucketCounts = LATENCY_BUCKETS_MS.map((b) => (args.value <= b ? 1 : 0));
  STORE.set(key, {
    type: 'histogram',
    sum: args.value,
    count: 1,
    buckets: [...LATENCY_BUCKETS_MS],
    bucketCounts,
    help: args.help,
  });
}

/** Set a gauge to a specific value. */
export function gaugeSet(args: {
  name: string;
  help: string;
  tags?: Record<string, string>;
  value: number;
}): void {
  const key = tagsToKey(args.name, args.tags);
  STORE.set(key, { type: 'gauge', value: args.value, help: args.help });
}

/**
 * Render the entire metrics store as Prometheus text exposition format.
 * Used by the /metrics endpoint to append AI metrics next to system metrics.
 */
export function renderPrometheus(): string {
  // Group entries by metric base-name so we emit "# HELP" / "# TYPE" once.
  const byName = new Map<
    string,
    {
      help: string;
      type: 'counter' | 'histogram' | 'gauge';
      entries: { key: string; entry: Entry }[];
    }
  >();
  for (const [key, entry] of STORE) {
    const name = key.split('{')[0]!;
    const bucket = byName.get(name) ?? { help: entry.help, type: entry.type, entries: [] };
    bucket.entries.push({ key, entry });
    byName.set(name, bucket);
  }

  const lines: string[] = [];
  for (const [name, group] of byName) {
    lines.push(`# HELP ${name} ${group.help}`);
    lines.push(`# TYPE ${name} ${group.type}`);
    for (const { key, entry } of group.entries) {
      if (entry.type === 'counter' || entry.type === 'gauge') {
        lines.push(`${key} ${entry.value.toString()}`);
      } else {
        // histogram: emit _bucket{le="..."}, _sum, _count
        const baseTags = key.includes('{') ? key.slice(key.indexOf('{') + 1, -1) : '';
        const prefix = baseTags ? `${name}_bucket{${baseTags},le=` : `${name}_bucket{le=`;
        for (let i = 0; i < entry.buckets.length; i += 1) {
          lines.push(
            `${prefix}"${entry.buckets[i]!.toString()}"} ${entry.bucketCounts[i]!.toString()}`,
          );
        }
        const infLine = baseTags
          ? `${name}_bucket{${baseTags},le="+Inf"} ${entry.count.toString()}`
          : `${name}_bucket{le="+Inf"} ${entry.count.toString()}`;
        lines.push(infLine);
        lines.push(`${name}_sum${baseTags ? `{${baseTags}}` : ''} ${entry.sum.toString()}`);
        lines.push(`${name}_count${baseTags ? `{${baseTags}}` : ''} ${entry.count.toString()}`);
      }
    }
  }
  return lines.join('\n');
}

/** Reset everything — for tests only. */
export function _resetMetrics(): void {
  STORE.clear();
}

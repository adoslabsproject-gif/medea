/**
 * OpenTelemetry distributed tracing — FlowForge runtime (per-tenant container).
 *
 * Configurazione via env (auto-propagato da onboarding.ts buildEnv):
 *   OTEL_EXPORTER_OTLP_ENDPOINT  — es. http://otel-collector.observability:4318/v1/traces
 *   OTEL_SERVICE_NAME            — default 'zeliai-flowforge-runtime'
 *   OTEL_RESOURCE_ATTRIBUTES     — KV opzionali (es. tenant.id=<wsId>)
 *
 * Resource attributes includono MEDEA_TENANT_ID per filtrare span per tenant.
 *
 * Se OTEL_EXPORTER_OTLP_ENDPOINT non configurato → SDK non parte (no-op safe).
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SecretScrubbingSpanProcessor } from './otel-scrubber.js';
import { logger as log } from './logger.js';

let sdk: NodeSDK | null = null;

export function initOtel(): void {
  if (sdk) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    log.info?.({ msg: 'OTEL_EXPORTER_OTLP_ENDPOINT not set — telemetry disabled' });
    return;
  }

  const tenantId = process.env.MEDEA_TENANT_ID ?? 'unknown';

  try {
    // Defense-in-depth contro secret leak: TUTTI gli span passano per
    // SecretScrubbingSpanProcessor che strippa query string + userInfo da
    // http.url/url.full/url.query/http.target PRIMA di essere flushed al
    // collector. Auto-instrumentation Node (http/undici) cattura URL
    // completi by default → senza scrubber, vendor URLs con `?api_key=`
    // leakeraebbero al collector (Stripe, Gmail, OAuth tokens, ecc.).
    // Test coverage: lib/otel-scrubber.test.ts (15 test 2026-grade).
    const exporter = new OTLPTraceExporter({ url: endpoint });
    const batchProcessor = new BatchSpanProcessor(exporter);
    const scrubbingProcessor = new SecretScrubbingSpanProcessor(batchProcessor);

    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'zeliai-flowforge-runtime',
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
        'tenant.id': tenantId,
      }),
      spanProcessors: [scrubbingProcessor],
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-http': { enabled: true },
          '@opentelemetry/instrumentation-pg': { enabled: true },
          '@opentelemetry/instrumentation-ioredis': { enabled: true },
        }),
      ],
    });
    sdk.start();
    log.info?.({ endpoint, tenantId, msg: 'OpenTelemetry started' });
  } catch (err) {
    log.warn?.({
      err: err instanceof Error ? err.message : String(err),
      msg: 'OpenTelemetry init failed — telemetry disabled',
    });
    sdk = null;
  }
}

export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    log.info?.({ msg: 'OpenTelemetry shutdown clean' });
  } catch (err) {
    log.warn?.({
      err: err instanceof Error ? err.message : String(err),
      msg: 'OpenTelemetry shutdown error',
    });
  } finally {
    sdk = null;
  }
}

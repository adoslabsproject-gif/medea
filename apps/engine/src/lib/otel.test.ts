/**
 * Test 2026-grade — otel.ts (OpenTelemetry SDK lifecycle).
 *
 * 🚨 SECURITY: SecretScrubbingSpanProcessor wrap obbligatorio prima del
 *    BatchSpanProcessor. Senza wrap → URL con `?api_key=...` leak al collector.
 *
 * 🚨 FAIL-SAFE: nessun endpoint env → SDK NON parte (no-op safe).
 *    Init throw → logged + sdk = null (no crash boot container).
 *
 * 🚨 IDEMPOTENZA: initOtel chiamato 2x → no double-init (sdk singleton).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sdkStartMock = vi.fn();
const sdkShutdownMock = vi.fn();
const NodeSDKMock = vi.fn(() => ({
  start: sdkStartMock,
  shutdown: sdkShutdownMock,
}));

vi.mock('@opentelemetry/sdk-node', () => ({ NodeSDK: NodeSDKMock }));

const getAutoInstrMock = vi.fn(() => ({}));
vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: getAutoInstrMock,
}));

const OTLPExporterMock = vi.fn();
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: OTLPExporterMock,
}));

const resourceFromAttributesMock = vi.fn((attrs: Record<string, unknown>) => ({
  attributes: attrs,
}));
vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: resourceFromAttributesMock,
}));

vi.mock('@opentelemetry/semantic-conventions', () => ({
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
}));

const BatchSpanProcessorMock = vi.fn();
vi.mock('@opentelemetry/sdk-trace-base', () => ({
  BatchSpanProcessor: BatchSpanProcessorMock,
}));

const SecretScrubbingSpanProcessorMock = vi.fn();
vi.mock('./otel-scrubber.js', () => ({
  SecretScrubbingSpanProcessor: SecretScrubbingSpanProcessorMock,
}));

const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('./logger.js', () => ({ logger: loggerMock }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_SERVICE_NAME;
  delete process.env.MEDEA_TENANT_ID;
  delete process.env.npm_package_version;
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadFresh() {
  return import('./otel.js');
}

describe('🚨 initOtel — guard endpoint missing', () => {
  it('🚨 OTEL_EXPORTER_OTLP_ENDPOINT non set → SDK NON parte, log info', async () => {
    const { initOtel } = await loadFresh();
    initOtel();
    expect(NodeSDKMock).not.toHaveBeenCalled();
    expect(sdkStartMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringMatching(/not set.*telemetry disabled/u),
      }),
    );
  });
});

describe('🚨 initOtel — happy path', () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318/v1/traces';
  });

  it('🚨 endpoint set → SDK created + started', async () => {
    const { initOtel } = await loadFresh();
    initOtel();
    expect(NodeSDKMock).toHaveBeenCalledTimes(1);
    expect(sdkStartMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'http://collector:4318/v1/traces',
        msg: 'OpenTelemetry started',
      }),
    );
  });

  it('🚨 OTLPTraceExporter chiamato con url = endpoint', async () => {
    const { initOtel } = await loadFresh();
    initOtel();
    expect(OTLPExporterMock).toHaveBeenCalledWith({
      url: 'http://collector:4318/v1/traces',
    });
  });

  it('🚨 SECURITY: SecretScrubbingSpanProcessor WRAPPA BatchSpanProcessor', async () => {
    const { initOtel } = await loadFresh();
    initOtel();
    expect(BatchSpanProcessorMock).toHaveBeenCalledTimes(1);
    expect(SecretScrubbingSpanProcessorMock).toHaveBeenCalledTimes(1);
    // L'argomento del scrubbing è l'instance del batch processor
    const batchInstance = BatchSpanProcessorMock.mock.instances[0];
    expect(SecretScrubbingSpanProcessorMock).toHaveBeenCalledWith(batchInstance);
  });

  it('🚨 SDK options: spanProcessors include solo scrubbing (NO batch direct)', async () => {
    const { initOtel } = await loadFresh();
    initOtel();
    const firstCall = NodeSDKMock.mock.calls[0] as unknown as readonly [unknown, ...unknown[]] | undefined;
    if (!firstCall) throw new Error('NodeSDK constructor not invoked');
    const sdkOpts = firstCall[0] as { spanProcessors: unknown[] };
    expect(sdkOpts.spanProcessors).toHaveLength(1);
    // L'unico processor è l'instance dello scrubbing
    const scrubbingInstance = SecretScrubbingSpanProcessorMock.mock.instances[0];
    expect(sdkOpts.spanProcessors[0]).toBe(scrubbingInstance);
  });

  it('🚨 Resource attributes: tenant.id da MEDEA_TENANT_ID env', async () => {
    process.env.MEDEA_TENANT_ID = 'tenant-prod-abc';
    const { initOtel } = await loadFresh();
    initOtel();
    expect(resourceFromAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        'tenant.id': 'tenant-prod-abc',
      }),
    );
  });

  it('🚨 Resource: tenant.id="unknown" se MEDEA_TENANT_ID assente', async () => {
    const { initOtel } = await loadFresh();
    initOtel();
    expect(resourceFromAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        'tenant.id': 'unknown',
      }),
    );
  });

  it('🚨 service.name default "zeliai-flowforge-runtime"', async () => {
    const { initOtel } = await loadFresh();
    initOtel();
    expect(resourceFromAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        'service.name': 'zeliai-flowforge-runtime',
      }),
    );
  });

  it('🚨 service.name custom da OTEL_SERVICE_NAME env', async () => {
    process.env.OTEL_SERVICE_NAME = 'custom-runtime-test';
    const { initOtel } = await loadFresh();
    initOtel();
    expect(resourceFromAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        'service.name': 'custom-runtime-test',
      }),
    );
  });

  it('🚨 service.version da npm_package_version env (fallback "0.0.0")', async () => {
    const { initOtel } = await loadFresh();
    initOtel();
    expect(resourceFromAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        'service.version': '0.0.0',
      }),
    );
  });

  it('🚨 instrumentation-fs disabilitato (rumore I/O)', async () => {
    const { initOtel } = await loadFresh();
    initOtel();
    expect(getAutoInstrMock).toHaveBeenCalledWith(
      expect.objectContaining({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    );
  });

  it('🚨 instrumentation http/pg/ioredis enabled', async () => {
    const { initOtel } = await loadFresh();
    initOtel();
    expect(getAutoInstrMock).toHaveBeenCalledWith(
      expect.objectContaining({
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
      }),
    );
  });
});

describe('🚨 initOtel — fail-safe boot', () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
  });

  it('🚨 sdk.start() throw → log warn + sdk = null (no crash)', async () => {
    sdkStartMock.mockImplementationOnce(() => { throw new Error('OTLP unreachable'); });
    const { initOtel, shutdownOtel } = await loadFresh();
    expect(() => initOtel()).not.toThrow();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: 'OTLP unreachable',
        msg: expect.stringMatching(/OpenTelemetry init failed/u),
      }),
    );
    // shutdownOtel no-op perché sdk null
    await shutdownOtel();
    expect(sdkShutdownMock).not.toHaveBeenCalled();
  });

  it('🚨 NodeSDK constructor throw → log warn + sdk = null', async () => {
    NodeSDKMock.mockImplementationOnce(() => { throw new Error('config invalid'); });
    const { initOtel } = await loadFresh();
    expect(() => initOtel()).not.toThrow();
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('🚨 non-Error throw → coerced a String safely', async () => {
    sdkStartMock.mockImplementationOnce(() => { throw 'string-not-Error'; });
    const { initOtel } = await loadFresh();
    expect(() => initOtel()).not.toThrow();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'string-not-Error' }),
    );
  });
});

describe('🚨 initOtel — idempotenza singleton', () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://x:4318';
  });

  it('🚨 2x initOtel → 1 sola init (singleton)', async () => {
    const { initOtel } = await loadFresh();
    initOtel();
    initOtel();
    initOtel();
    expect(NodeSDKMock).toHaveBeenCalledTimes(1);
    expect(sdkStartMock).toHaveBeenCalledTimes(1);
  });
});

describe('🚨 shutdownOtel — graceful', () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://x:4318';
  });

  it('🚨 sdk init poi shutdown → sdk.shutdown chiamato', async () => {
    sdkShutdownMock.mockResolvedValue(undefined);
    const { initOtel, shutdownOtel } = await loadFresh();
    initOtel();
    await shutdownOtel();
    expect(sdkShutdownMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'OpenTelemetry shutdown clean' }),
    );
  });

  it('🚨 shutdown PRIMA di init → no-op (no throw)', async () => {
    const { shutdownOtel } = await loadFresh();
    await shutdownOtel();
    expect(sdkShutdownMock).not.toHaveBeenCalled();
  });

  it('🚨 shutdown 2x → 2nd no-op (sdk già null)', async () => {
    sdkShutdownMock.mockResolvedValue(undefined);
    const { initOtel, shutdownOtel } = await loadFresh();
    initOtel();
    await shutdownOtel();
    await shutdownOtel();
    expect(sdkShutdownMock).toHaveBeenCalledTimes(1);
  });

  it('🚨 shutdown throw → log warn (NO propagate)', async () => {
    sdkShutdownMock.mockRejectedValue(new Error('flush failed'));
    const { initOtel, shutdownOtel } = await loadFresh();
    initOtel();
    await expect(shutdownOtel()).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: 'flush failed',
        msg: expect.stringMatching(/shutdown error/u),
      }),
    );
  });

  it('🚨 dopo shutdown clean → initOtel può ri-bootare (sdk null reset)', async () => {
    sdkShutdownMock.mockResolvedValue(undefined);
    const { initOtel, shutdownOtel } = await loadFresh();
    initOtel();
    await shutdownOtel();
    initOtel(); // ri-init
    expect(NodeSDKMock).toHaveBeenCalledTimes(2);
  });
});

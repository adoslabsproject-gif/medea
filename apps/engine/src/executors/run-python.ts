/**
 * action_run_python — Python execution via code-runner microservice.
 *
 * Delegates to the code-runner Docker sandbox at CODE_RUNNER_URL (default
 * http://127.0.0.1:5003). The microservice spawns ephemeral containers with
 * --network=none, --memory=512m, --cpus=1.0, --read-only, --pids-limit=50,
 * --security-opt=no-new-privileges, non-root user.
 *
 * The previous node's output is injected as JSON in env var MEDEA_INPUT
 * (Python: `json.loads(os.environ["MEDEA_INPUT"])`).
 *
 * Stdout is optionally parsed as JSON for typed downstream chaining;
 * stderr + exit_code + duration + output files (base64) are always returned.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { makeBinaryInline } from '@medea/engine-core-schema';
import { internalAwareFetch } from '@/lib/internal-service-fetch.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';

// Container tenant raggiunge code-runner PM2 sul host via host-gateway
// (ExtraHosts `host.docker.internal:host-gateway` in HostConfig).
// Override via env CODE_RUNNER_URL per dev locale (es. http://127.0.0.1:5003).
const CODE_RUNNER_URL = process.env.CODE_RUNNER_URL ?? 'http://host.docker.internal:5003';
const HEALTH_TIMEOUT_MS = 2000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 120_000;

interface CodeRunnerResponse {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  duration_ms?: number;
  files?: { name: string; mime: string; size_bytes: number; base64: string }[];
  error?: string;
}

function clampTimeout(raw: unknown): number {
  const n = Number(raw ?? 30_000);
  if (!Number.isFinite(n)) return 30_000;
  return Math.min(Math.max(Math.floor(n), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

export const runPythonExecutor: NodeExecutor = async (rawConfig, input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const code = coerceString(cfg.code ?? '').trim();
  if (!code) throw new Error('action_run_python: campo "code" obbligatorio.');
  if (code.length > 50_000) throw new Error('action_run_python: codice troppo lungo (max 50KB).');

  // CANCEL cooperativo (fix 2026-06-17): se il run è già stato annullato, non
  // avviare nemmeno l'esecuzione sandbox (prima sprecava un round-trip al code-runner).
  if (context.abortSignal?.aborted) {
    throw new Error('action_run_python: annullato (run cancellato).');
  }
  const timeoutMs = clampTimeout(cfg.timeoutMs);
  const parseJson =
    cfg.parseStdoutJson !== false && coerceString(cfg.parseStdoutJson ?? 'true') !== 'false';
  // Network opt-in: default false → sandbox --network=none. ON → rete
  // bridge dedicata con egress filter SSRF-block (vedi setup-egress-network.sh).
  const allowNetwork = cfg.allowNetwork === true || cfg.allowNetwork === 'true';

  // Health check
  try {
    const h = await internalAwareFetch(`${CODE_RUNNER_URL}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!h.ok) {
      throw new Error(`code-runner health HTTP ${String(h.status)}`);
    }
    const hb = await readJsonCapped<{ status?: string; docker?: boolean; image?: boolean }>(h);
    if (!hb.docker || !hb.image) {
      throw new Error('code-runner: Docker o immagine sandbox non pronti.');
    }
  } catch (e) {
    throw new Error(
      `action_run_python: code-runner non raggiungibile su ${CODE_RUNNER_URL} (${e instanceof Error ? e.message : String(e)}). ` +
        'Verifica che il servizio code-runner sia attivo (systemctl status zeliai-code-runner).',
    );
  }

  // Inject previous node output come file separato in sandbox (input.json).
  // Pattern enterprise: il codice Python legge da file deterministico invece di
  // ricevere stringa embedded nel source (che apriva quoting/escape edge case
  // e impediva debug del source come scritto dall'utente).
  let injectedInput = '{}';
  try {
    injectedInput = JSON.stringify(input ?? {});
  } catch {
    /* circular / not serializable → keep {} */
  }

  // Prelude minimale: legge input.json e popola MEDEA_INPUT come dict +
  // come env var (back-compat con esempi vecchi). Il codice utente arriva intatto.
  const PRELUDE =
    `import json as _json, os as _os\n` +
    `with open('/home/sandbox/work/input.json', 'r', encoding='utf-8') as _fh:\n` +
    `    MEDEA_INPUT = _json.load(_fh)\n` +
    `_os.environ['MEDEA_INPUT'] = _json.dumps(MEDEA_INPUT)\n` +
    `del _fh, _json, _os\n\n`;

  const userId = `tenant-${context.tenantId}`;

  const res = await internalAwareFetch(`${CODE_RUNNER_URL}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: PRELUDE + code,
      timeout_ms: timeoutMs,
      user_id: userId,
      inject_files: [{ name: 'input.json', content: injectedInput }],
      allow_network: allowNetwork,
    }),
    // Signal COMBINATO: timeout per-call + cancel del run (ctx.abortSignal) → un
    // cancel utente aborta la chiamata in volo subito, non dopo il timeout.
    signal: context.abortSignal
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs + 5000), context.abortSignal])
      : AbortSignal.timeout(timeoutMs + 5000),
  });

  if (res.status === 429)
    throw new Error('action_run_python: rate limit superato (max 10 esecuzioni/min per tenant).');
  if (res.status === 503)
    throw new Error('action_run_python: code-runner occupato, riprova tra qualche secondo.');
  if (!res.ok) {
    const txt = (await readTextTruncated(res, 65_536).catch(() => ({ text: '' }))).text;
    throw new Error(`action_run_python: HTTP ${String(res.status)} ${txt.slice(0, 200)}`);
  }

  const body = await readJsonCapped<CodeRunnerResponse>(res);

  if (!body.success) {
    throw new Error(
      `action_run_python: esecuzione fallita (exit ${String(body.exit_code ?? -1)}). ` +
        `stderr: ${(body.stderr ?? body.error ?? '').slice(0, 1500)}`,
    );
  }

  const stdout = body.stdout ?? '';
  let parsedStdout: unknown = stdout;
  if (parseJson && stdout.trim().length > 0) {
    try {
      parsedStdout = JSON.parse(stdout);
    } catch {
      /* keep string */
    }
  }

  // REF-PRIMARIO: ogni file prodotto dallo script diventa un handle BinaryData
  // (ref content-addressed con store, inline base64 senza = fail-soft) invece di
  // base64 grezzo nel payload. Si collega a Write File / email / http upload.
  const files = await Promise.all(
    (body.files ?? []).map(async (f) => {
      const binary = context.writeBinary
        ? await context.writeBinary(Buffer.from(f.base64, 'base64'), {
            mimeType: f.mime,
            fileName: f.name,
          })
        : makeBinaryInline({ mimeType: f.mime, data: f.base64, fileName: f.name });
      return { name: f.name, mime: f.mime, size_bytes: f.size_bytes, binary };
    }),
  );

  return {
    output: {
      stdout: parsedStdout,
      stderr: body.stderr ?? '',
      exitCode: body.exit_code ?? 0,
      durationMs: body.duration_ms ?? 0,
      files,
      // Network observability: il consumer downstream sa se questo step
      // ha potuto effettuare egress (audit forensic + debug runtime).
      allowedNetwork: allowNetwork,
    },
    durationMs: Date.now() - start,
  };
};

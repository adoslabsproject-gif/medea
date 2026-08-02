/**
 * /studio — pagina PRIVATA di generazione media servita dal runtime ALL'URL DEL
 * TENANT, accesso via TOKEN nell'URL (come i webhook hosted di FlowForge): NIENTE
 * login. Apri `https://<tenant>/studio/<token>` (anche da mobile) e usi.
 *
 * Il token è un segreto persistente per-container (`<MEDEA_DATA_DIR>/.studio-token`,
 * generato random alla prima richiesta, 0600). URL/token errato → 404 (stealth).
 * GET /studio/<token> valida + setta cookie HttpOnly → le API /studio/* usano il cookie.
 *
 * Riusa i mattoni testati: builder grafo + ComfyClient + estrazione media
 * (executors/comfyui) + storage DB tenant (private-gen). ComfyUI via gateway docker
 * (STUDIO_COMFY_URL, default http://172.20.0.1:8188). Nessun filtro.
 *
 * @module routes/studio
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { readJsonCapped } from '@/lib/capped-response.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ComfyClient } from '../../executors/comfyui/client.js';
import { buildTxt2ImgGraph } from '../../executors/comfyui/txt2img-graph.js';
import { substituteGraphVariables } from '../../executors/comfyui/interpolate-graph.js';
import { firstMedia } from '../../executors/comfyui/extract-output.js';
import { resolveSeed, clampInt, toNum, toStr } from '../../executors/comfyui/shared.js';
import { createPrivateGenerationsService } from '../../services/private-generations/index.js';
import { getBinaryStore } from '../../services/binary-store.service.js';
import { loggerFor } from '../../lib/logger.js';
import { STUDIO_PAGE_HTML } from './page.js';
import { buildWanVideoGraph, buildWanExtendGraph } from './wan-graph.js';
import { resolveOutputDims } from './fit-dims.js';
import { dimsFromParams } from './persist-helpers.js';

const log = loggerFor('routes.studio');
const COOKIE = 'gs_studio';

/** Metadati di un job di generazione in corso (per salvarlo a completamento nel polling). */
interface JobMeta { prompt: string; negative: string; params: Record<string, unknown>; seed: number; checkpoint: string; conversationId: string | undefined; createdAt: number }
const jobs = new Map<string, JobMeta>();
/** Pulizia job vecchi (>1h) per non far crescere la mappa all'infinito. */
function gcJobs(): void {
  const cutoff = Date.now() - 3_600_000;
  for (const [id, m] of jobs) if (m.createdAt < cutoff) jobs.delete(id);
}

function comfyUrl(): string {
  return process.env.STUDIO_COMFY_URL || 'http://172.20.0.1:8188';
}

/** Carica un'immagine (data URL base64) in ComfyUI/input → ritorna il nome file. */
async function uploadToComfy(dataUrl: string): Promise<string> {
  const raw = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 0) throw new Error('immagine vuota');
  const fd = new FormData();
  fd.append('image', new Blob([bytes], { type: 'image/png' }), `studio_${Date.now()}.png`);
  fd.append('overwrite', 'true');
  const r = await fetch(`${comfyUrl()}/upload/image`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`upload immagine fallito (HTTP ${r.status})`);
  const j = await readJsonCapped<{ name?: string; subfolder?: string }>(r);
  if (!j.name) throw new Error('upload immagine: nessun nome restituito');
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

/** Carica un video (mp4 bytes) nell'input dir di ComfyUI → ritorna il nome file (per LoadVideo). */
async function uploadVideoToComfy(bytes: Buffer, name: string): Promise<string> {
  if (bytes.length === 0) throw new Error('video sorgente vuoto');
  const fd = new FormData();
  fd.append('image', new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), name); // /upload/image accetta anche video (è l'endpoint usato da LoadVideo)
  fd.append('overwrite', 'true');
  const r = await fetch(`${comfyUrl()}/upload/image`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`upload video fallito (HTTP ${r.status})`);
  const j = (await r.json()) as { name?: string; subfolder?: string };
  if (!j.name) throw new Error('upload video: nessun nome restituito');
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

function tokenFile(): string {
  return `${process.env.MEDEA_DATA_DIR || './data'}/.studio-token`;
}

/** Coercizione sicura di una lista LoRA salvata nei params (unknown) → {name,weight}[]. */
function coerceLoras(v: unknown): { name: string; weight: number }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): { name: string; weight: number }[] => {
    if (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string') {
      return [{ name: (x as { name: string }).name, weight: toNum((x as { weight?: unknown }).weight, 0.8) }];
    }
    return [];
  });
}

let tokenPromise: Promise<string> | null = null;
/** Token segreto persistente del container: letto o generato (random, 0600). Memoizzato. */
function getStudioToken(): Promise<string> {
  tokenPromise ??= (async () => {
      const path = tokenFile();
      try {
        const existing = (await readFile(path, 'utf8')).trim();
        if (existing.length >= 16) return existing;
      } catch { /* assente → genera */ }
      const tok = randomBytes(24).toString('hex');
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, tok, { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'studio token non persistito (uso in-memory)');
      }
      return tok;
    })();
  return tokenPromise;
}

function eq(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function cookieToken(c: Context): string {
  const segs = c.req.header('cookie')?.split(';').map((s) => s.trim()) ?? [];
  const m = segs.find((s) => s.startsWith(`${COOKIE}=`));
  return m ? m.slice(COOKIE.length + 1) : '';
}

const GenerateSchema = z.object({
  mode: z.enum(['sdxl', 'custom']).default('sdxl'),
  prompt: z.string().max(8000).default(''),
  negative: z.string().max(4000).optional(),
  checkpoint: z.string().max(300).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  steps: z.number().optional(),
  cfg: z.number().optional(),
  sampler: z.string().max(40).optional(),
  scheduler: z.string().max(40).optional(),
  sampling: z.enum(['eps', 'v_prediction']).optional(),
  seed: z.number().optional(),
  denoise: z.number().optional(),
  hires: z.boolean().optional(),
  // immagine di partenza (data URL base64) per img2img (sdxl) o i2v (video custom)
  initImageB64: z.string().max(20_000_000).optional(),
  loras: z.array(z.object({
    name: z.string().max(200),
    strengthModel: z.number().optional(),
    strengthClip: z.number().optional(),
  })).max(8).optional(),
  graphJson: z.string().max(200_000).optional(),
  variables: z.record(z.string()).optional(),
  timeout_s: z.number().optional(),
  conversationId: z.string().regex(/^[\w-]{1,64}$/).optional(),
  // Video Wan 2.2 con catena LoRA su entrambi gli stadi + ⚡Turbo (lightning).
  // Quando presente, il grafo è costruito SERVER-SIDE (buildWanVideoGraph) invece
  // del graphJson client: i nomi-file LoRA restano server-side e validati.
  video: z.object({
    kind: z.enum(['i2v', 't2v']),
    width: z.number(),
    height: z.number(),
    length: z.number(),
    fps: z.number(),
    steps: z.number().optional(),
    cfg: z.number().optional(),
    turbo: z.boolean().optional(),
    slowmo: z.number().int().min(1).max(4).optional(),
    // Dimensioni naturali del file caricato (i2v): se presenti, il server tara
    // width/height al FORMATO reale → niente foto tagliate (vedi resolveOutputDims).
    srcWidth: z.number().optional(),
    srcHeight: z.number().optional(),
    loras: z.array(z.object({ name: z.string().max(40), weight: z.number().min(0).max(2) })).max(6).optional(),
  }).optional(),
});

export function createStudioRoutes(): Hono {
  const app = new Hono();

  async function authed(c: Context): Promise<boolean> {
    return eq(cookieToken(c), await getStudioToken());
  }

  // Liste modelli (checkpoint + LoRA) da ComfyUI → popolano i menù a tendina.
  // Fail-soft: ComfyUI spento (llm-mode) → liste vuote, la pagina resta usabile.
  app.get('/studio/models', async (c) => {
    if (!(await authed(c))) return c.json({ ok: false, error: 'non autorizzato' }, 401);
    const base = comfyUrl();
    const listFor = async (node: string, input: string): Promise<string[]> => {
      try {
        const r = await fetch(`${base}/object_info/${node}`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return [];
        const j = await readJsonCapped<Record<string, { input?: { required?: Record<string, unknown[]> } }>>(r);
        const arr = j[node]?.input?.required?.[input]?.[0];
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    };
    const [checkpoints, loras] = await Promise.all([
      listFor('CheckpointLoaderSimple', 'ckpt_name'),
      listFor('LoraLoader', 'lora_name'),
    ]);
    return c.json({ ok: true, checkpoints, loras });
  });

  // ⚠️ ORDINE CRITICO: questa route GET 2-segmenti DEVE stare PRIMA di
  // `/studio/:token` (anch'essa GET 2-segmenti), altrimenti `:token` cattura
  // "conversations" come fosse un token → mismatch → 404 (era il bug 2026-06-18:
  // la pagina "💬 Salvate" non caricava nulla). I dati ERANO salvati: solo la
  // lista era oscurata dal catch-all. /studio/models è già sopra per lo stesso
  // motivo; le route a 3 segmenti (/studio/conversation/:id, /studio/status/:id)
  // non collidono. C'è un guard test che lo verifica.
  app.get('/studio/conversations', async (c) => {
    if (!(await authed(c))) return c.json({ ok: false, error: 'non autorizzato' }, 401);
    try {
      return c.json({ ok: true, items: await createPrivateGenerationsService().conversations() });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'studio conversations fallito');
      return c.json({ ok: false, error: 'lista fallita' }, 500);
    }
  });

  // Apertura via token nell'URL → set cookie → serve la pagina. Token errato → 404 (stealth).
  app.get('/studio/:token', async (c) => {
    if (!eq(c.req.param('token'), await getStudioToken())) return c.notFound();
    c.header('Set-Cookie', `${COOKIE}=${c.req.param('token')}; HttpOnly; SameSite=Lax; Path=/studio; Max-Age=31536000`);
    return c.html(STUDIO_PAGE_HTML);
  });

  app.post('/studio/generate', async (c) => {
    if (!(await authed(c))) return c.json({ ok: false, error: 'non autorizzato' }, 401);
    const parsed = GenerateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: false, error: 'parametri non validi' }, 400);
    const b = parsed.data;

    let graph: unknown;
    const seed = resolveSeed(b.seed);
    try {
      // Immagine di partenza (img2img / i2v): caricata in ComfyUI → nome file.
      const startImage = b.initImageB64 ? await uploadToComfy(b.initImageB64) : '';
      if (b.video) {
        // Video Wan 2.2: grafo costruito server-side con catena LoRA high/low + turbo.
        if (b.video.kind === 'i2v' && !startImage) {
          return c.json({ ok: false, error: 'la modalità i2v richiede una foto di partenza' }, 400);
        }
        // Tara le dimensioni al FORMATO della foto caricata (i2v) → niente crop/stretch.
        const vdims = resolveOutputDims(b.video.srcWidth, b.video.srcHeight, b.video.width, b.video.height);
        graph = buildWanVideoGraph({
          mode: b.video.kind,
          prompt: b.prompt,
          negative: toStr(b.negative),
          width: vdims.width,
          height: vdims.height,
          length: b.video.length,
          fps: b.video.fps,
          seed,
          steps: b.video.steps ?? 30,
          cfg: b.video.cfg ?? 5,
          ...(startImage ? { startImage } : {}),
          loras: b.video.loras ?? [],
          turbo: b.video.turbo ?? false,
          slowmo: b.video.slowmo ?? 1,
        });
      } else if (b.mode === 'custom') {
        const vars = { ...(b.variables ?? {}), ...(startImage ? { start_image: startImage } : {}) };
        graph = substituteGraphVariables(toStr(b.graphJson), vars);
      } else {
        if (!b.prompt.trim()) return c.json({ ok: false, error: 'prompt mancante' }, 400);
        if (!toStr(b.checkpoint).trim()) return c.json({ ok: false, error: 'checkpoint mancante' }, 400);
        graph = buildTxt2ImgGraph({
          checkpoint: toStr(b.checkpoint).trim(),
          prompt: b.prompt,
          negative: toStr(b.negative),
          width: clampInt(b.width, 256, 2048, 1024),
          height: clampInt(b.height, 256, 2048, 1024),
          steps: clampInt(b.steps, 1, 80, 30),
          cfg: Math.min(30, Math.max(1, toNum(b.cfg, 7))),
          sampler: toStr(b.sampler) || 'euler',
          scheduler: toStr(b.scheduler) || 'normal',
          seed,
          batchSize: 1,
          samplingMode: b.sampling === 'v_prediction' ? 'v_prediction' : 'eps',
          ...(b.loras ? { loras: b.loras } : {}),
          ...(startImage ? { initImage: startImage } : {}),
          ...(b.denoise !== undefined ? { denoise: b.denoise } : {}),
          ...(b.hires ? { hires: true } : {}),
        });
      }
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'grafo non valido' }, 400);
    }

    // ASYNC: accoda in ComfyUI e ritorna SUBITO un jobId. Il client fa polling su
    // /studio/status (evita il timeout ~100s del proxy/Cloudflare sui video lunghi).
    try {
      const promptId = await new ComfyClient(comfyUrl()).submitPrompt(graph, `studio-${seed}`);
      gcJobs();
      // Per i video salviamo i parametri che servono all'ESTENSIONE (kind/width/
      // height/length/fps/turbo/loras); per gli altri, i param classici.
      const params: Record<string, unknown> = b.video
        ? { kind: b.video.kind, width: b.video.width, height: b.video.height, length: b.video.length, fps: b.video.fps, turbo: b.video.turbo ?? false, loras: b.video.loras ?? [] }
        : { mode: b.mode, sampler: b.sampler, steps: b.steps, cfg: b.cfg, width: b.width, height: b.height };
      jobs.set(promptId, {
        prompt: b.prompt,
        negative: toStr(b.negative),
        params,
        seed,
        checkpoint: b.mode === 'sdxl' && !b.video ? toStr(b.checkpoint) : '',
        conversationId: b.conversationId,
        createdAt: Date.now(),
      });
      return c.json({ ok: true, jobId: promptId, seed });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'studio submit fallito');
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'invio fallito' }, 502);
    }
  });

  // ESTENDI un video: carica il sorgente in ComfyUI → ultimo frame → continuazione i2v
  // (LoRA su entrambi gli stadi + turbo) → concat → mp4 più lungo. Ritorna un jobId
  // come /generate (il client poll-a /studio/status). I param della continuazione (loras/
  // turbo/length) vengono dal body, default = quelli del clip sorgente.
  const ExtendSchema = z.object({
    // Descrizione opzionale della CONTINUAZIONE (popup lato UI). Vuota/assente →
    // riusa il prompt del video sorgente.
    prompt: z.string().max(2000).optional(),
    negative: z.string().max(2000).optional(),
    turbo: z.boolean().optional(),
    length: z.number().optional(),
    slowmo: z.number().int().min(1).max(4).optional(),
    loras: z.array(z.object({ name: z.string().max(40), weight: z.number().min(0).max(2) })).max(6).optional(),
    conversationId: z.string().regex(/^[\w-]{1,64}$/).optional(),
  });
  app.post('/studio/extend/:id', async (c) => {
    if (!(await authed(c))) return c.json({ ok: false, error: 'non autorizzato' }, 401);
    const parsed = ExtendSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: false, error: 'parametri non validi' }, 400);
    const e = parsed.data;
    const svc = createPrivateGenerationsService();
    let src: Awaited<ReturnType<typeof svc.getForExtend>>;
    try {
      src = await svc.getForExtend(c.req.param('id'));
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'id non valido' }, 400);
    }
    if (!src) return c.json({ ok: false, error: 'generazione non trovata' }, 404);
    if (!src.mime.startsWith('video/')) return c.json({ ok: false, error: 'si possono estendere solo i video' }, 400);

    const p = src.params;
    const srcLen = clampInt(toNum(p.length, 121), 1, 100000, 121);
    const width = clampInt(toNum(p.width, 832), 256, 1280, 832);
    const height = clampInt(toNum(p.height, 480), 256, 1280, 480);
    const turbo = e.turbo ?? Boolean(p.turbo);
    const loras = e.loras ?? coerceLoras(p.loras);
    const contLen = clampInt(e.length, 1, 121, srcLen);
    const seed = resolveSeed(undefined);
    // Descrizione della continuazione: quella del popup, o fallback al prompt sorgente.
    const effPrompt = e.prompt?.trim() || src.prompt;
    try {
      const comfyFile = await uploadVideoToComfy(src.bytes, `studio_src_${Date.now().toString()}.mp4`);
      const graph = buildWanExtendGraph({
        sourceFile: comfyFile, sourceFrames: srcLen, prompt: effPrompt, negative: e.negative ?? '',
        width, height, length: contLen, seed, steps: 30, cfg: 5, loras, turbo,
        slowmo: e.slowmo ?? 1,
      });
      const promptId = await new ComfyClient(comfyUrl()).submitPrompt(graph, `studio-ext-${seed.toString()}`);
      gcJobs();
      jobs.set(promptId, {
        prompt: effPrompt,
        negative: e.negative ?? '',
        params: { kind: 'i2v', width, height, length: srcLen + contLen, turbo, loras },
        seed,
        checkpoint: '',
        conversationId: e.conversationId,
        createdAt: Date.now(),
      });
      return c.json({ ok: true, jobId: promptId, seed });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'studio extend fallito');
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'estensione fallita' }, 502);
    }
  });

  // ESTENDI un mp4 CARICATO dall'utente (non una generazione dello studio):
  // decodifica il data URL → ComfyUI → ultimo frame (count ignoto → batch_index
  // grande, ImageFromBatch clampa) → continuazione i2v → concat. I frame sorgente
  // vengono riscalati alla risoluzione del pannello (scaleSourceToTarget) perché
  // l'mp4 caricato ha risoluzione arbitraria.
  const ExtendUploadSchema = z.object({
    videoB64: z.string().min(1).max(120_000_000),
    prompt: z.string().max(2000).optional(),
    negative: z.string().max(2000).optional(),
    turbo: z.boolean().optional(),
    length: z.number().optional(),
    slowmo: z.number().int().min(1).max(4).optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    // Dimensioni naturali del video caricato → il server tara al FORMATO reale.
    srcWidth: z.number().optional(),
    srcHeight: z.number().optional(),
    loras: z.array(z.object({ name: z.string().max(40), weight: z.number().min(0).max(2) })).max(6).optional(),
    conversationId: z.string().regex(/^[\w-]{1,64}$/).optional(),
  });
  app.post('/studio/extend-upload', async (c) => {
    if (!(await authed(c))) return c.json({ ok: false, error: 'non autorizzato' }, 401);
    const parsed = ExtendUploadSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: false, error: 'parametri non validi' }, 400);
    const e = parsed.data;
    const rawB64 = e.videoB64.includes(',') ? e.videoB64.slice(e.videoB64.indexOf(',') + 1) : e.videoB64;
    const bytes = Buffer.from(rawB64, 'base64');
    if (bytes.length < 1000) return c.json({ ok: false, error: 'video caricato non valido o vuoto' }, 400);

    // Tara al FORMATO del video caricato (risoluzione arbitraria) → niente crop.
    const upDims = resolveOutputDims(e.srcWidth, e.srcHeight, e.width ?? 832, e.height ?? 480);
    const width = upDims.width;
    const height = upDims.height;
    const turbo = e.turbo ?? true;
    const loras = e.loras ?? [];
    const contLen = clampInt(e.length, 1, 121, 81);
    const seed = resolveSeed(undefined);
    const effPrompt = e.prompt?.trim() ?? '';
    try {
      const comfyFile = await uploadVideoToComfy(bytes, `studio_up_${Date.now().toString()}.mp4`);
      const graph = buildWanExtendGraph({
        sourceFile: comfyFile, sourceFrames: 100000, scaleSourceToTarget: true,
        prompt: effPrompt, negative: e.negative ?? '',
        width, height, length: contLen, seed, steps: 30, cfg: 5, loras, turbo,
        slowmo: e.slowmo ?? 1,
      });
      const promptId = await new ComfyClient(comfyUrl()).submitPrompt(graph, `studio-extup-${seed.toString()}`);
      gcJobs();
      jobs.set(promptId, {
        prompt: effPrompt,
        negative: e.negative ?? '',
        params: { kind: 'i2v', width, height, length: contLen, turbo, loras },
        seed,
        checkpoint: '',
        conversationId: e.conversationId,
        createdAt: Date.now(),
      });
      return c.json({ ok: true, jobId: promptId, seed });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'studio extend-upload fallito');
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'estensione fallita' }, 502);
    }
  });

  // Polling stato job: pending | done (salva media nel DB + ritorna url) | error.
  app.get('/studio/status/:jobId', async (c) => {
    if (!(await authed(c))) return c.json({ ok: false, error: 'non autorizzato' }, 401);
    const jobId = c.req.param('jobId');
    try {
      const client = new ComfyClient(comfyUrl());
      const res = await client.checkHistory(jobId);
      if (res.state === 'pending') return c.json({ ok: true, status: 'running' });
      if (res.state === 'error') { jobs.delete(jobId); return c.json({ ok: false, status: 'error', error: res.error ?? 'errore' }); }
      // done → estrai media, salva nel DB tenant
      const ref = firstMedia(res.outputs ?? {});
      const media = await client.fetchMedia(ref);
      const meta = jobs.get(jobId);
      // width/height vivono dentro params (immagini e video) → promuoviamoli alle
      // colonne dedicate, altrimenti restano NULL nella tabella generazioni.
      const metaParams = meta?.params ?? {};
      const dims = dimsFromParams(metaParams);
      const saved = await createPrivateGenerationsService().save({
        kind: ref.kind,
        prompt: meta?.prompt ?? '',
        negative: meta?.negative ?? '',
        params: metaParams,
        seed: meta?.seed ?? 0,
        checkpoint: meta?.checkpoint ?? '',
        ...(dims.width !== undefined ? { width: dims.width } : {}),
        ...(dims.height !== undefined ? { height: dims.height } : {}),
        conversationId: meta?.conversationId,
        mime: media.mimeType,
        bytes: media.bytes,
      });
      jobs.delete(jobId);
      const url = `/studio/media/${saved.mediaRef}?mime=${encodeURIComponent(media.mimeType)}`;
      return c.json({ ok: true, status: 'done', id: saved.id, kind: ref.kind, seed: meta?.seed ?? 0, mime: media.mimeType, url });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'studio status fallito');
      return c.json({ ok: false, status: 'error', error: err instanceof Error ? err.message : 'errore' });
    }
  });

  // STOP: interrompe un job (in corso o in coda) → libera subito la GPU.
  // Studio = single-user (owner, token-gated): rimuovo lo specifico id dalla
  // coda pending E interrompo l'esecuzione in corso (l'unico job che gira è il suo).
  app.post('/studio/cancel/:jobId', async (c) => {
    if (!(await authed(c))) return c.json({ ok: false, error: 'non autorizzato' }, 401);
    const jobId = c.req.param('jobId');
    const base = comfyUrl();
    try {
      // 1) toglilo dalla coda se è ancora pending
      await fetch(`${base}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [jobId] }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      // 2) interrompi l'esecuzione in corso
      await fetch(`${base}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      jobs.delete(jobId);
      return c.json({ ok: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'studio cancel fallito');
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'stop fallito' }, 502);
    }
  });

  app.post('/studio/rate', async (c) => {
    if (!(await authed(c))) return c.json({ ok: false, error: 'non autorizzato' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; rating?: unknown };
    const id = toStr(body.id);
    const rating = body.rating === 'up' || body.rating === 'down' ? body.rating : body.rating === null ? null : undefined;
    if (!id || rating === undefined) return c.json({ ok: false, error: 'parametri non validi' }, 400);
    try {
      await createPrivateGenerationsService().rate(id, rating);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, error: 'voto fallito' }, 500);
    }
  });

  app.get('/studio/media/:ref', async (c) => {
    if (!(await authed(c))) return c.json({ ok: false, error: 'non autorizzato' }, 401);
    const mime = c.req.query('mime') ?? 'application/octet-stream';
    try {
      const bytes = await getBinaryStore().read(c.req.param('ref')); // valida ref sha256 → anti-traversal
      return new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' },
      });
    } catch {
      return c.json({ ok: false, error: 'media non trovato' }, 404);
    }
  });

  // Carica una conversazione (per riprenderla) — con gli URL del media pronti.
  app.get('/studio/conversation/:id', async (c) => {
    if (!(await authed(c))) return c.json({ ok: false, error: 'non autorizzato' }, 401);
    try {
      const items = await createPrivateGenerationsService().conversation(c.req.param('id'));
      return c.json({ ok: true, items: items.map((it) => ({ ...it, url: `/studio/media/${it.media_ref}?mime=${encodeURIComponent(it.mime)}` })) });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'caricamento fallito' }, 400);
    }
  });

  // Cancella una conversazione.
  app.delete('/studio/conversation/:id', async (c) => {
    if (!(await authed(c))) return c.json({ ok: false, error: 'non autorizzato' }, 401);
    try {
      await createPrivateGenerationsService().deleteConversation(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : 'cancellazione fallita' }, 400);
    }
  });

  return app;
}

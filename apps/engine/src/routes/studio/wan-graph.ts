/**
 * wan-graph — costruzione PURA del grafo ComfyUI per i video Wan 2.2 (14B),
 * con catena LoRA su ENTRAMBI gli stadi (high-noise + low-noise) e modalità ⚡Turbo.
 *
 * Punto chiave di Wan 2.2: il sampling è a 2 esperti (KSamplerAdvanced ×2). Ogni
 * LoRA Wan ha una metà HIGH (movimento/composizione) e una metà LOW (dettaglio/
 * stile): la HIGH va sul model path dell'unet_high, la LOW su quello dell'unet_low.
 * Applicarne una sola metà degrada il risultato → qui le mettiamo SEMPRE entrambe.
 *
 * ⚡Turbo = LoRA lightning (lightx2v 4-step, anch'esso high+low) + steps=4, cfg=1,
 * split 2+2 → da ~20 min a ~3 min per clip.
 *
 * Modulo PURO (nessun fetch, nessun I/O): la route valida lo spec e poi chiama
 * `buildWanVideoGraph`. Così la logica di wiring è unit-testabile in isolamento.
 *
 * @module routes/studio/wan-graph
 */

export type WanMode = 'i2v' | 't2v';

/** Coppia di file LoRA (metà high + metà low) per Wan 2.2. */
export interface LoraPair {
  high: string;
  low: string;
}

/**
 * Catalogo LoRA video (nomi-file REALI su disco, verificati 2026-06-18). Alcuni
 * sono specifici per modalità (i2v/t2v), altri valgono per entrambe (`both`).
 * Chiave = nome friendly mostrato in UI.
 */
const WAN_LORAS: Record<string, Partial<Record<WanMode | 'both', LoraPair>>> = {
  animeStyle: {
    i2v: { high: 'wan_animeStyle-I2V_HIGH__v2.safetensors', low: 'wan_animeStyle-I2V_LOW__wan2.2_i2v_animestyle_v2_low.safetensors' },
    t2v: { high: 'wan_animeStyle-T2V_HIGH__v2.safetensors', low: 'wan_animeStyle-T2V_LOW__wan2.2_t2v_animestyle_v2_low.safetensors' },
  },
  switchToAnime: {
    i2v: { high: 'wan_switchToAnime-I2V_HIGH__wan2.2_i2v_animestyletransition_high.safetensors', low: 'wan_switchToAnime-I2V_LOW__wan2.2_i2v_animestyletransition_low.safetensors' },
  },
  retro90s: {
    both: { high: 'wan_retro90sAnime_HIGH__goldenboylora-22-HIGH-e01.safetensors', low: 'wan_retro90sAnime_LOW__goldenboylora-22-LOW-V2-e106.safetensors' },
  },
  generalNSFW: {
    both: { high: 'wan_generalNSFW__NSFW-22-H-e8.safetensors', low: 'wan_generalNSFW_LOW__NSFW-22-L-e8.safetensors' },
  },
};

/** LoRA lightning (turbo) — coppia i2v high+low. */
const WAN_LIGHTNING: LoraPair = {
  high: 'wan_lightning-speed_I2V_HIGH__lightx2v_4step_1022.safetensors',
  low: 'wan_lightning-speed_I2V_LOW__lightx2v_4step_1022.safetensors',
};

/** I nomi friendly selezionabili in UI (esposti per popolare il selettore). */
export function listWanLoras(mode: WanMode): { name: string; available: boolean }[] {
  return Object.keys(WAN_LORAS).map((name) => ({ name, available: resolveWanLora(name, mode) !== null }));
}

/** Risolve un nome friendly → coppia high/low per la modalità, o null se non applicabile. */
export function resolveWanLora(name: string, mode: WanMode): LoraPair | null {
  const entry = WAN_LORAS[name];
  if (!entry) return null;
  return entry[mode] ?? entry.both ?? null;
}

export interface WanLoraSelection {
  /** Nome friendly dal catalogo. */
  name: string;
  /** Peso (strength_model). Clampato 0..2. */
  weight: number;
}

export interface WanVideoSpec {
  mode: WanMode;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  /** Frame totali. */
  length: number;
  fps: number;
  seed: number;
  /** Step richiesti (ignorati in turbo: forzati a 4). */
  steps: number;
  /** CFG (ignorato in turbo: forzato a 1). */
  cfg: number;
  /** Nome file immagine già caricato in ComfyUI (solo i2v). */
  startImage?: string | undefined;
  /** LoRA selezionati (friendly + peso). */
  loras: WanLoraSelection[];
  /** ⚡Turbo: aggiunge lightning + 4 step / cfg 1 / split 2+2. */
  turbo: boolean;
  /**
   * Slow-motion FLUIDO via interpolazione RIFE: moltiplicatore di frame (1 = off).
   * Wan genera `length` frame; RIFE ne crea `slowmo×` interpolando i fotogrammi
   * intermedi, e il video viene assemblato allo STESSO fps → durata ×slowmo,
   * movimento a 1/slowmo della velocità, MA fluido (no judder). 2 = metà velocità.
   */
  slowmo?: number;
}

interface GraphNode { class_type: string; inputs: Record<string, unknown> }
type Graph = Record<string, GraphNode>;

// ⚠️ ACCOPPIAMENTO COI FILE SU DISCO: questi nomi devono esistere in ComfyUI
// (models/diffusion_models). 2026-06-18 l'owner è passato da fp8 → fp16 ("senza
// quantizzazione") e gli fp8 sono spariti → il grafo che puntava agli fp8 veniva
// RIFIUTATO ("value not in list"). Tenuti fp16 = stato attuale del disco. (Per
// renderlo immune agli swap servirebbe risolverli a runtime dalla lista ComfyUI.)
const I2V_HIGH = 'wan2.2_i2v_high_noise_14B_fp16.safetensors';
const I2V_LOW = 'wan2.2_i2v_low_noise_14B_fp16.safetensors';
const T2V_HIGH = 'wan2.2_t2v_high_noise_14B_fp16.safetensors';
const T2V_LOW = 'wan2.2_t2v_low_noise_14B_fp16.safetensors';

// Slow-motion: modello RIFE per FrameInterpolate (in ComfyUI models/frame_interpolation).
const RIFE_MODEL = 'rife_v4.26_heavy.safetensors';
// Limite multiplier del nodo FrameInterpolate (max 16); cap pratico a 4 (=0.25x).
const RIFE_MAX_MULTIPLIER = 4;

const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v)));
const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Inserisce una catena di `LoraLoaderModelOnly` su un model path e ritorna il
 * riferimento [nodeId, 0] dell'ULTIMO nodo (da collegare a ModelSamplingSD3).
 * `stage` = 'h' | 'l' per id univoci; `pick(pair)` sceglie la metà high/low.
 */
function appendLoraChain(
  graph: Graph,
  stage: 'h' | 'l',
  baseRef: [string, number],
  loras: { file: string; weight: number }[],
): [string, number] {
  let prev = baseRef;
  loras.forEach((l, i) => {
    const id = `lora_${stage}${i.toString()}`;
    graph[id] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: prev, lora_name: l.file, strength_model: l.weight },
    };
    prev = [id, 0];
  });
  return prev;
}

/**
 * Slow-motion FLUIDO condiviso (generate + extend): se `slowmoRaw` > 1 inserisce
 * la coppia RIFE (loader + FrameInterpolate ×N) tra `framesRef` e il CreateVideo,
 * e ritorna il ref dei frame interpolati. multiplier 1 (o assente) = no-op → ritorna
 * `framesRef` invariato. CreateVideo userà poi lo STESSO fps → durata ×N (movimento
 * a 1/N), ma fluido. UNA sola implementazione → generate ed extend non divergono.
 */
function appendSlowmo(graph: Graph, framesRef: [string, number], slowmoRaw: number | undefined): [string, number] {
  const slowmo = clampInt(slowmoRaw ?? 1, 1, RIFE_MAX_MULTIPLIER);
  if (slowmo <= 1) return framesRef;
  graph.interpModel = { class_type: 'FrameInterpolationModelLoader', inputs: { model_name: RIFE_MODEL } };
  graph.interp = { class_type: 'FrameInterpolate', inputs: { interp_model: ['interpModel', 0], images: framesRef, multiplier: slowmo } };
  return ['interp', 0];
}

/** Risolve i LoRA scelti (+ lightning se turbo) in liste high/low pesate per i 2 stadi. */
function resolvePairs(loras: WanLoraSelection[], mode: WanMode, turbo: boolean): {
  high: { file: string; weight: number }[];
  low: { file: string; weight: number }[];
} {
  const pairs: { pair: LoraPair; weight: number }[] = [];
  if (turbo) pairs.push({ pair: WAN_LIGHTNING, weight: 1 }); // lightning per primo
  for (const sel of loras) {
    const pair = resolveWanLora(sel.name, mode);
    if (pair) pairs.push({ pair, weight: clampNum(sel.weight, 0, 2) });
  }
  return {
    high: pairs.map((p) => ({ file: p.pair.high, weight: p.weight })),
    low: pairs.map((p) => ({ file: p.pair.low, weight: p.weight })),
  };
}

/** Nodi base condivisi (unet high/low + clip + vae + positive/negative). */
function baseNodes(prompt: string, negative: string, isI2V: boolean): Graph {
  return {
    unet_h: { class_type: 'UNETLoader', inputs: { unet_name: isI2V ? I2V_HIGH : T2V_HIGH, weight_dtype: 'default' } },
    unet_l: { class_type: 'UNETLoader', inputs: { unet_name: isI2V ? I2V_LOW : T2V_LOW, weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['clip', 0] } },
    neg: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['clip', 0] } },
  };
}

interface SamplerCoreOpts {
  /** Ref dell'immagine di partenza i2v ([nodeId,0]) — null = t2v (latente vuoto). */
  startImageRef: [string, number] | null;
  high: { file: string; weight: number }[];
  low: { file: string; weight: number }[];
  seed: number; steps: number; cfg: number; half: number;
  width: number; height: number; length: number;
}

/**
 * Aggiunge il cuore di sampling Wan 2.2 a `graph` (presuppone unet_h/unet_l/clip/
 * vae/pos/neg già presenti): catene LoRA high/low → ModelSamplingSD3 ×2 → sorgente
 * latente (i2v WanImageToVideo se c'è startImage, altrimenti t2v) → KSamplerAdvanced
 * ×2 (split high/low) → VAEDecode. Ritorna il ref del VAEDecode. Condiviso da
 * buildWanVideoGraph e buildWanExtendGraph → un solo wiring high/low da mantenere.
 */
function attachSamplerCore(graph: Graph, o: SamplerCoreOpts): [string, number] {
  const highModel = appendLoraChain(graph, 'h', ['unet_h', 0], o.high);
  const lowModel = appendLoraChain(graph, 'l', ['unet_l', 0], o.low);
  graph.msh = { class_type: 'ModelSamplingSD3', inputs: { model: highModel, shift: 8.0 } };
  graph.msl = { class_type: 'ModelSamplingSD3', inputs: { model: lowModel, shift: 8.0 } };

  let ksPos: [string, number]; let ksNeg: [string, number]; let latentSrc: [string, number];
  if (o.startImageRef) {
    graph.i2v = {
      class_type: 'WanImageToVideo',
      inputs: { positive: ['pos', 0], negative: ['neg', 0], vae: ['vae', 0], width: o.width, height: o.height, length: o.length, batch_size: 1, start_image: o.startImageRef },
    };
    ksPos = ['i2v', 0]; ksNeg = ['i2v', 1]; latentSrc = ['i2v', 2];
  } else {
    graph.latent = { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['vae', 0], width: o.width, height: o.height, length: o.length, batch_size: 1 } };
    ksPos = ['pos', 0]; ksNeg = ['neg', 0]; latentSrc = ['latent', 0];
  }
  graph.ks1 = {
    class_type: 'KSamplerAdvanced',
    inputs: { model: ['msh', 0], add_noise: 'enable', noise_seed: o.seed, steps: o.steps, cfg: o.cfg, sampler_name: 'euler', scheduler: 'simple', positive: ksPos, negative: ksNeg, latent_image: latentSrc, start_at_step: 0, end_at_step: o.half, return_with_leftover_noise: 'enable' },
  };
  graph.ks2 = {
    class_type: 'KSamplerAdvanced',
    inputs: { model: ['msl', 0], add_noise: 'disable', noise_seed: o.seed, steps: o.steps, cfg: o.cfg, sampler_name: 'euler', scheduler: 'simple', positive: ksPos, negative: ksNeg, latent_image: ['ks1', 0], start_at_step: o.half, end_at_step: 10000, return_with_leftover_noise: 'disable' },
  };
  graph.decode = { class_type: 'VAEDecode', inputs: { samples: ['ks2', 0], vae: ['vae', 0] } };
  return ['decode', 0];
}

/** Step/cfg/split effettivi (turbo forza 4 step / cfg 1 / split 2+2). */
function samplerParams(turbo: boolean, steps: number, cfg: number): { steps: number; cfg: number; half: number } {
  if (turbo) return { steps: 4, cfg: 1, half: 2 };
  const s = clampInt(steps, 1, 80);
  return { steps: s, cfg: clampNum(cfg, 1, 30), half: Math.max(1, Math.floor(s / 2)) };
}

/**
 * Costruisce il grafo ComfyUI completo per un video Wan 2.2 14B (i2v o t2v),
 * con i LoRA selezionati su entrambi gli stadi + eventuale turbo (lightning).
 *
 * Non lancia: i valori sono clampati a range sicuri. I LoRA non risolvibili per
 * la modalità vengono SCARTATI silenziosamente (la lista UI già marca l'availability).
 */
export function buildWanVideoGraph(spec: WanVideoSpec): Graph {
  const { steps, cfg, half } = samplerParams(spec.turbo, spec.steps, spec.cfg);
  const width = clampInt(spec.width, 256, 1280);
  const height = clampInt(spec.height, 256, 1280);
  const length = clampInt(spec.length, 1, 121);
  const fps = clampInt(spec.fps, 1, 60);
  const isI2V = spec.mode === 'i2v';
  const { high, low } = resolvePairs(spec.loras, spec.mode, spec.turbo);

  const graph = baseNodes(spec.prompt, spec.negative, isI2V);
  let startImageRef: [string, number] | null = null;
  if (isI2V) {
    graph.img = { class_type: 'LoadImage', inputs: { image: spec.startImage ?? '' } };
    startImageRef = ['img', 0];
  }
  attachSamplerCore(graph, { startImageRef, high, low, seed: spec.seed, steps, cfg, half, width, height, length });

  // Slow-motion fluido: interpola i frame con RIFE (multiplier ×N) e assembla
  // allo STESSO fps → durata ×N, movimento 1/N ma fluido (no judder). multiplier
  // 1 = off → CreateVideo legge direttamente dal decode (grafo invariato).
  const framesRef = appendSlowmo(graph, ['decode', 0], spec.slowmo);
  graph.vid = { class_type: 'CreateVideo', inputs: { images: framesRef, fps } };
  graph.save = { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: 'genstudio', format: 'mp4', codec: 'h264' } };
  return graph;
}

export interface WanExtendSpec {
  /** Filename del video sorgente caricato nell'input dir di ComfyUI. */
  sourceFile: string;
  /** Frame totali del clip sorgente (per estrarne l'ULTIMO via ImageFromBatch). */
  sourceFrames: number;
  prompt: string;
  negative: string;
  /** Risoluzione della continuazione (= quella del sorgente, così ImageBatch non riscala). */
  width: number;
  height: number;
  /** Frame della CONTINUAZIONE da generare. */
  length: number;
  seed: number;
  steps: number;
  cfg: number;
  loras: WanLoraSelection[];
  turbo: boolean;
  /**
   * Se true, riscala i frame sorgente alla risoluzione target (width×height)
   * prima del concat. Serve per gli UPLOAD: un mp4 caricato ha risoluzione
   * ignota/diversa → senza riscalare, ImageBatch(sorgente, continuazione)
   * fallirebbe per mismatch dimensioni. Per i video GENERATI si omette
   * (sorgente e continuazione hanno già la stessa risoluzione → nessun riscalo).
   */
  scaleSourceToTarget?: boolean;
  /**
   * Slow-motion RIFE sul video ESTESO (sorgente + continuazione): moltiplicatore
   * di frame (1 = off). Interpola l'INTERO video concatenato → rallenta tutto
   * uniformemente, allo stesso fps del sorgente. Stessa semantica della generate.
   */
  slowmo?: number;
}

/**
 * Estende un video: carica il sorgente → estrae l'ultimo frame → genera una
 * continuazione i2v (LoRA su entrambi gli stadi + turbo) → CONCATENA i frame del
 * sorgente con quelli nuovi → un unico mp4 più lungo. Tutto in ComfyUI (no ffmpeg).
 * L'estensione è SEMPRE i2v (parte dall'ultimo frame); l'fps resta quello del sorgente.
 *
 * NB sourceFrames → batch_index dell'ultimo frame. ComfyUI `ImageFromBatch`
 * VALIDA batch_index contro max=16384 PRIMA di eseguire (NON è un clamp lato
 * runtime!) → un valore oltre fa RIFIUTARE il grafo (HTTP 400 value_bigger_than_max).
 * Per i video generati passiamo il count reale; per gli upload (count ignoto) un
 * sentinella grande. In ENTRAMBI i casi cappiamo a 16384: a esecuzione
 * ImageFromBatch fa `min(shape-1, batch_index)`, quindi per i video con ≤16384
 * frame (praticamente tutti: 16384 @16fps ≈ 17 min) prende comunque l'ultimo.
 */
const COMFY_MAX_BATCH_INDEX = 16384;
export function buildWanExtendGraph(spec: WanExtendSpec): Graph {
  const { steps, cfg, half } = samplerParams(spec.turbo, spec.steps, spec.cfg);
  const width = clampInt(spec.width, 256, 1280);
  const height = clampInt(spec.height, 256, 1280);
  const length = clampInt(spec.length, 1, 121);
  const lastIdx = Math.min(COMFY_MAX_BATCH_INDEX, Math.max(0, clampInt(spec.sourceFrames, 1, 1_000_000) - 1));
  const { high, low } = resolvePairs(spec.loras, 'i2v', spec.turbo);

  const graph = baseNodes(spec.prompt, spec.negative, true);
  graph.src = { class_type: 'LoadVideo', inputs: { file: spec.sourceFile } };
  // GetVideoComponents → [0]=IMAGE(frames) [1]=AUDIO [2]=fps [3]=count.
  graph.gvc = { class_type: 'GetVideoComponents', inputs: { video: ['src', 0] } };
  // Sorgente dei frame per ultimo-frame + concat: riscalato (upload) o raw (generati).
  let frameSource: [string, number] = ['gvc', 0];
  if (spec.scaleSourceToTarget) {
    graph.scaled = {
      class_type: 'ImageScale',
      inputs: { image: ['gvc', 0], width, height, upscale_method: 'lanczos', crop: 'disabled' },
    };
    frameSource = ['scaled', 0];
  }
  graph.last = { class_type: 'ImageFromBatch', inputs: { image: frameSource, batch_index: lastIdx, length: 1 } };
  attachSamplerCore(graph, { startImageRef: ['last', 0], high, low, seed: spec.seed, steps, cfg, half, width, height, length });
  // Concatena frame sorgente + continuazione → un solo video; fps del sorgente.
  graph.combined = { class_type: 'ImageBatch', inputs: { image1: frameSource, image2: ['decode', 0] } };
  // Slow-motion (opzionale): interpola l'INTERO video concatenato allo stesso fps.
  const framesRef = appendSlowmo(graph, ['combined', 0], spec.slowmo);
  graph.vid = { class_type: 'CreateVideo', inputs: { images: framesRef, fps: ['gvc', 2] } };
  graph.save = { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: 'genstudio', format: 'mp4', codec: 'h264' } };
  return graph;
}

/**
 * Builder PURO del grafo ComfyUI per il txt2img (famiglia SD/SDXL) — usato da
 * /studio (la generazione privata). Supporta catena LoRA, v-prediction, e tutti
 * i parametri di sampling. Niente I/O → testabile in isolamento.
 *
 * @module executors/comfyui/txt2img-graph
 */

/** Un LoRA da applicare (file in models/loras + intensità). */
export interface LoraSpec {
  name: string;
  strengthModel?: number | undefined;
  strengthClip?: number | undefined;
}

export interface Txt2ImgParams {
  checkpoint: string;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  batchSize: number;
  /** 'eps' (default) o 'v_prediction' — alcuni checkpoint richiedono v-pred. */
  samplingMode: 'eps' | 'v_prediction';
  /** Catena LoRA opzionale (applicati in sequenza su model+clip). */
  loras?: LoraSpec[];
  /** img2img: nome file immagine di partenza (caricato in ComfyUI/input). Vuoto = txt2img. */
  initImage?: string | undefined;
  /** Forza del denoise per img2img (0..1, default 0.6). Ignorato in txt2img (=1). */
  denoise?: number | undefined;
  /** Hires-fix: upscale latente ×1.5 + 2° pass a basso denoise → più nitidezza/risoluzione. Solo txt2img. */
  hires?: boolean | undefined;
}

interface GraphNode { class_type: string; inputs: Record<string, unknown> }
export type ComfyGraph = Record<string, GraphNode>;

type Link = [string, number];

/**
 * Costruisce il grafo txt2img. La catena è: checkpoint → (LoRA…) →
 * (ModelSamplingDiscrete se v-pred) → KSampler; CLIP positive/negative pescano
 * dal clip POST-LoRA. v-prediction è necessario ai modelli v-pred (senza,
 * l'output esce "bruciato"/grigio).
 */
export function buildTxt2ImgGraph(p: Txt2ImgParams): ComfyGraph {
  const graph: ComfyGraph = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.checkpoint } },
  };

  // Latente: vuoto (txt2img) o dall'immagine di partenza (img2img).
  const initImage = (p.initImage ?? '').trim();
  let latentSrc: Link;
  let denoise = 1.0;
  if (initImage) {
    graph.load = { class_type: 'LoadImage', inputs: { image: initImage } };
    graph.encode = { class_type: 'VAEEncode', inputs: { pixels: ['load', 0], vae: ['4', 2] } };
    latentSrc = ['encode', 0];
    denoise = Math.min(1, Math.max(0, p.denoise ?? 0.6)); // img2img: <1 mantiene la foto
  } else {
    graph['5'] = { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: p.batchSize } };
    latentSrc = ['5', 0];
  }

  // Sorgenti correnti di MODEL e CLIP: partono dal checkpoint, poi attraversano
  // ogni LoRA in catena.
  let modelSrc: Link = ['4', 0];
  let clipSrc: Link = ['4', 1];

  const loras = (p.loras ?? []).filter((l) => l.name.trim() !== '');
  loras.forEach((lora, i) => {
    const id = `lora${i}`;
    graph[id] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: lora.name.trim(),
        strength_model: lora.strengthModel ?? 1.0,
        strength_clip: lora.strengthClip ?? 1.0,
        model: modelSrc,
        clip: clipSrc,
      },
    };
    modelSrc = [id, 0];
    clipSrc = [id, 1];
  });

  if (p.samplingMode === 'v_prediction') {
    graph['10'] = { class_type: 'ModelSamplingDiscrete', inputs: { model: modelSrc, sampling: 'v_prediction', zsnr: false } };
    modelSrc = ['10', 0];
  }

  graph['6'] = { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: clipSrc } };
  graph['7'] = { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: clipSrc } };
  graph['3'] = {
    class_type: 'KSampler',
    inputs: {
      seed: p.seed,
      steps: p.steps,
      cfg: p.cfg,
      sampler_name: p.sampler,
      scheduler: p.scheduler,
      denoise,
      model: modelSrc,
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: latentSrc,
    },
  };
  // Hires-fix (solo txt2img): upscale latente ×1.5 + 2° pass a basso denoise → più nitidezza.
  let sampleSrc: Link = ['3', 0];
  if (p.hires && !initImage) {
    graph.up = { class_type: 'LatentUpscaleBy', inputs: { samples: ['3', 0], upscale_method: 'bislerp', scale_by: 1.5 } };
    graph['3b'] = {
      class_type: 'KSampler',
      inputs: {
        seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler,
        denoise: 0.45, model: modelSrc, positive: ['6', 0], negative: ['7', 0], latent_image: ['up', 0],
      },
    };
    sampleSrc = ['3b', 0];
  }

  graph['8'] = { class_type: 'VAEDecode', inputs: { samples: sampleSrc, vae: ['4', 2] } };
  graph['9'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'genstudio', images: ['8', 0] } };
  return graph;
}

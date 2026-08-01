import { describe, it, expect } from 'vitest';
import { buildWanVideoGraph, buildWanExtendGraph, resolveWanLora, listWanLoras, type WanVideoSpec, type WanExtendSpec } from './wan-graph.js';

function baseSpec(over: Partial<WanVideoSpec> = {}): WanVideoSpec {
  return {
    mode: 'i2v', prompt: 'p', negative: 'n', width: 832, height: 480, length: 49, fps: 16,
    seed: 7, steps: 30, cfg: 5, startImage: 'foto.png', loras: [], turbo: false, ...over,
  };
}

/** Estrae la catena di lora_name lungo un model path partendo da uno stadio (h/l). */
function chainFiles(graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>, stage: 'h' | 'l'): string[] {
  const files: string[] = [];
  for (let i = 0; ; i++) {
    const node = graph[`lora_${stage}${i.toString()}`];
    if (!node) break;
    files.push(node.inputs.lora_name as string);
  }
  return files;
}

describe('resolveWanLora — catalogo high/low per modalità', () => {
  it('animeStyle ha coppie distinte per i2v e t2v', () => {
    const i = resolveWanLora('animeStyle', 'i2v');
    const t = resolveWanLora('animeStyle', 't2v');
    expect(i?.high).toMatch(/animeStyle-I2V_HIGH/);
    expect(i?.low).toMatch(/animeStyle-I2V_LOW/);
    expect(t?.high).toMatch(/animeStyle-T2V_HIGH/);
    expect(i?.high).not.toBe(t?.high);
  });
  it('generalNSFW e retro90s valgono per entrambe (both)', () => {
    expect(resolveWanLora('generalNSFW', 'i2v')?.high).toMatch(/generalNSFW/);
    expect(resolveWanLora('generalNSFW', 't2v')?.low).toMatch(/generalNSFW_LOW/);
    expect(resolveWanLora('retro90s', 't2v')?.high).toMatch(/retro90sAnime_HIGH/);
  });
  it('switchToAnime SOLO i2v → null in t2v', () => {
    expect(resolveWanLora('switchToAnime', 'i2v')).not.toBeNull();
    expect(resolveWanLora('switchToAnime', 't2v')).toBeNull();
  });
  it('nome sconosciuto → null', () => {
    expect(resolveWanLora('inesistente', 'i2v')).toBeNull();
  });
  it('listWanLoras marca availability per modalità', () => {
    const t2v = listWanLoras('t2v');
    expect(t2v.find((l) => l.name === 'switchToAnime')?.available).toBe(false);
    expect(t2v.find((l) => l.name === 'animeStyle')?.available).toBe(true);
  });
});

describe('buildWanVideoGraph — i2v base', () => {
  it('senza LoRA: msh/msl collegati DIRETTAMENTE agli unet (nessun nodo lora)', () => {
    const g = buildWanVideoGraph(baseSpec());
    expect(g.msh!.inputs.model).toEqual(['unet_h', 0]);
    expect(g.msl!.inputs.model).toEqual(['unet_l', 0]);
    expect(chainFiles(g, 'h')).toEqual([]);
    expect(g.unet_h!.inputs.unet_name).toMatch(/i2v_high/);
    expect(g.unet_l!.inputs.unet_name).toMatch(/i2v_low/);
    // i2v: usa WanImageToVideo + LoadImage
    expect(g.i2v!.class_type).toBe('WanImageToVideo');
    expect(g.img!.inputs.image).toBe('foto.png');
    expect(g.ks1!.inputs.positive).toEqual(['i2v', 0]);
    expect(g.ks1!.inputs.latent_image).toEqual(['i2v', 2]);
  });

  it('🚨 LoRA su ENTRAMBI gli stadi: HIGH sul path di unet_h, LOW su unet_l; msh/msl puntano all\'ultimo lora', () => {
    const g = buildWanVideoGraph(baseSpec({ loras: [{ name: 'animeStyle', weight: 0.8 }, { name: 'generalNSFW', weight: 0.6 }] }));
    const high = chainFiles(g, 'h');
    const low = chainFiles(g, 'l');
    expect(high).toEqual([
      expect.stringMatching(/animeStyle-I2V_HIGH/),
      expect.stringMatching(/generalNSFW/),
    ]);
    expect(low).toEqual([
      expect.stringMatching(/animeStyle-I2V_LOW/),
      expect.stringMatching(/generalNSFW_LOW/),
    ]);
    // catena: unet_h → lora_h0 → lora_h1 → msh
    expect(g.lora_h0!.inputs.model).toEqual(['unet_h', 0]);
    expect(g.lora_h1!.inputs.model).toEqual(['lora_h0', 0]);
    expect(g.msh!.inputs.model).toEqual(['lora_h1', 0]);
    expect(g.msl!.inputs.model).toEqual(['lora_l1', 0]);
    // pesi propagati
    expect(g.lora_h0!.inputs.strength_model).toBe(0.8);
    expect(g.lora_h1!.inputs.strength_model).toBe(0.6);
  });

  it('LoRA non disponibile per la modalità → SCARTATO (t2v + switchToAnime)', () => {
    const g = buildWanVideoGraph(baseSpec({ mode: 't2v', startImage: undefined, loras: [{ name: 'switchToAnime', weight: 1 }, { name: 'animeStyle', weight: 1 }] }));
    const high = chainFiles(g, 'h');
    expect(high).toHaveLength(1); // solo animeStyle (T2V); switchToAnime scartato
    expect(high[0]).toMatch(/animeStyle-T2V_HIGH/);
  });

  it('peso fuori range → clampato 0..2', () => {
    const g = buildWanVideoGraph(baseSpec({ loras: [{ name: 'animeStyle', weight: 9 }] }));
    expect(g.lora_h0!.inputs.strength_model).toBe(2);
  });
});

describe('buildWanVideoGraph — ⚡Turbo (lightning)', () => {
  it('turbo: aggiunge lightning (high+low) come PRIMO lora + steps=4 / cfg=1 / split 2+2', () => {
    const g = buildWanVideoGraph(baseSpec({ turbo: true, loras: [{ name: 'animeStyle', weight: 0.8 }] }));
    const high = chainFiles(g, 'h');
    expect(high[0]).toMatch(/lightning-speed_I2V_HIGH/); // lightning per primo
    expect(high[1]).toMatch(/animeStyle-I2V_HIGH/);
    expect(chainFiles(g, 'l')[0]).toMatch(/lightning-speed_I2V_LOW/);
    expect(g.ks1!.inputs.steps).toBe(4);
    expect(g.ks1!.inputs.cfg).toBe(1);
    expect(g.ks1!.inputs.end_at_step).toBe(2);   // half = 2
    expect(g.ks2!.inputs.start_at_step).toBe(2);
  });

  it('turbo SENZA altri lora → solo lightning su entrambi gli stadi', () => {
    const g = buildWanVideoGraph(baseSpec({ turbo: true, loras: [] }));
    expect(chainFiles(g, 'h')).toEqual([expect.stringMatching(/lightning-speed_I2V_HIGH/)]);
    expect(chainFiles(g, 'l')).toEqual([expect.stringMatching(/lightning-speed_I2V_LOW/)]);
  });

  it('NON turbo: steps/cfg dallo spec, half = floor(steps/2)', () => {
    const g = buildWanVideoGraph(baseSpec({ steps: 20, cfg: 6 }));
    expect(g.ks1!.inputs.steps).toBe(20);
    expect(g.ks1!.inputs.cfg).toBe(6);
    expect(g.ks1!.inputs.end_at_step).toBe(10);
  });
});

describe('buildWanVideoGraph — t2v + clamp dimensioni', () => {
  it('t2v: niente LoadImage, usa Wan22ImageToVideoLatent, ks da pos/neg', () => {
    const g = buildWanVideoGraph(baseSpec({ mode: 't2v', startImage: undefined }));
    expect(g.img).toBeUndefined();
    expect(g.latent!.class_type).toBe('Wan22ImageToVideoLatent');
    expect(g.unet_h!.inputs.unet_name).toMatch(/t2v_high/);
    expect(g.ks1!.inputs.positive).toEqual(['pos', 0]);
    expect(g.ks1!.inputs.latent_image).toEqual(['latent', 0]);
  });

  it('dimensioni/length oltre i limiti → clampate (720p, 121 frame max)', () => {
    const g = buildWanVideoGraph(baseSpec({ width: 4096, height: 4096, length: 9999 }));
    expect(g.i2v!.inputs.width).toBe(1280);
    expect(g.i2v!.inputs.height).toBe(1280);
    expect(g.i2v!.inputs.length).toBe(121);
  });

  it('output sempre mp4 h264 via SaveVideo', () => {
    const g = buildWanVideoGraph(baseSpec());
    expect(g.save!.class_type).toBe('SaveVideo');
    expect(g.save!.inputs.format).toBe('mp4');
    expect(g.vid!.inputs.fps).toBe(16);
  });
});

describe('buildWanVideoGraph — slow-motion fluido (interpolazione RIFE)', () => {
  it('slowmo assente/1: NESSUN nodo interp, CreateVideo legge dal decode', () => {
    const g = buildWanVideoGraph(baseSpec());
    expect(g.interp).toBeUndefined();
    expect(g.interpModel).toBeUndefined();
    expect(g.vid!.inputs.images).toEqual(['decode', 0]);
  });

  it('slowmo=2: inserisce RIFE loader+interpolate, CreateVideo legge dall\'interp', () => {
    const g = buildWanVideoGraph(baseSpec({ slowmo: 2 }));
    // MUTATION: senza il ramo interp → images resta ['decode',0] → rosso.
    expect(g.interpModel!.class_type).toBe('FrameInterpolationModelLoader');
    expect(g.interpModel!.inputs.model_name).toBe('rife_v4.26_heavy.safetensors');
    expect(g.interp!.class_type).toBe('FrameInterpolate');
    expect(g.interp!.inputs.multiplier).toBe(2);
    expect(g.interp!.inputs.images).toEqual(['decode', 0]);
    expect(g.vid!.inputs.images).toEqual(['interp', 0]);
  });

  it('fps INVARIATO con slow-mo → durata cresce dai frame interpolati (no judder)', () => {
    const g = buildWanVideoGraph(baseSpec({ fps: 16, slowmo: 3 }));
    expect(g.vid!.inputs.fps).toBe(16); // l'fps NON scende: lo slow-mo viene dai frame in più
    expect(g.interp!.inputs.multiplier).toBe(3);
  });

  it('slowmo oltre il max è clampato a 4', () => {
    const g = buildWanVideoGraph(baseSpec({ slowmo: 99 }));
    expect(g.interp!.inputs.multiplier).toBe(4);
  });
});

describe('buildWanExtendGraph — estensione (concat in ComfyUI, no ffmpeg)', () => {
  function extSpec(over: Partial<WanExtendSpec> = {}): WanExtendSpec {
    return { sourceFile: 'clip.mp4', sourceFrames: 25, prompt: 'continua', negative: 'n', width: 480, height: 480, length: 25, seed: 5, steps: 30, cfg: 5, loras: [], turbo: false, ...over };
  }
  it('🚨 carica il video → estrae l\'ULTIMO frame (sourceFrames-1) → i2v da lì → concat + fps del sorgente', () => {
    const g = buildWanExtendGraph(extSpec());
    expect(g.src!.class_type).toBe('LoadVideo');
    expect(g.src!.inputs.file).toBe('clip.mp4');
    expect(g.gvc!.class_type).toBe('GetVideoComponents');
    expect(g.last!.class_type).toBe('ImageFromBatch');
    expect(g.last!.inputs.batch_index).toBe(24); // 25-1 = ultimo frame
    expect(g.last!.inputs.image).toEqual(['gvc', 0]);
    expect(g.i2v!.inputs.start_image).toEqual(['last', 0]); // continuazione parte dall'ultimo frame
    // concat: frame sorgente (image1) + continuazione (image2) → un solo video
    expect(g.combined!.class_type).toBe('ImageBatch');
    expect(g.combined!.inputs.image1).toEqual(['gvc', 0]);
    expect(g.combined!.inputs.image2).toEqual(['decode', 0]);
    expect(g.vid!.inputs.images).toEqual(['combined', 0]);
    expect(g.vid!.inputs.fps).toEqual(['gvc', 2]); // fps del sorgente, non un literal
  });
  it('LoRA su ENTRAMBI gli stadi + turbo anche in estensione', () => {
    const g = buildWanExtendGraph(extSpec({ turbo: true, loras: [{ name: 'animeStyle', weight: 0.8 }] }));
    expect(chainFiles(g, 'h')[0]).toMatch(/lightning-speed_I2V_HIGH/);
    expect(chainFiles(g, 'h')[1]).toMatch(/animeStyle-I2V_HIGH/);
    expect(chainFiles(g, 'l')[1]).toMatch(/animeStyle-I2V_LOW/);
    expect(g.ks1!.inputs.steps).toBe(4);
    expect(g.ks1!.inputs.cfg).toBe(1);
  });
  it('sourceFrames=1 → batch_index 0 (mai negativo)', () => {
    expect(buildWanExtendGraph(extSpec({ sourceFrames: 1 })).last!.inputs.batch_index).toBe(0);
  });

  it('🚨 default (video generato): NESSUN riscalo → last/concat su [gvc,0], no nodo scaled', () => {
    const g = buildWanExtendGraph(extSpec());
    expect(g.scaled).toBeUndefined();
    expect(g.last!.inputs.image).toEqual(['gvc', 0]);
    expect(g.combined!.inputs.image1).toEqual(['gvc', 0]);
  });

  it('🚨 scaleSourceToTarget (upload): ImageScale a w×h + last/concat su [scaled,0]', () => {
    const g = buildWanExtendGraph(extSpec({ scaleSourceToTarget: true, width: 832, height: 480 }));
    expect(g.scaled!.class_type).toBe('ImageScale');
    expect(g.scaled!.inputs.image).toEqual(['gvc', 0]);
    expect(g.scaled!.inputs.width).toBe(832);
    expect(g.scaled!.inputs.height).toBe(480);
    // ultimo frame + concat ora vengono dai frame RISCALATI (no mismatch con la continuazione)
    expect(g.last!.inputs.image).toEqual(['scaled', 0]);
    expect(g.combined!.inputs.image1).toEqual(['scaled', 0]);
    expect(g.combined!.inputs.image2).toEqual(['decode', 0]);
    // fps sempre dal sorgente reale
    expect(g.vid!.inputs.fps).toEqual(['gvc', 2]);
  });

  it('🔴 upload count ignoto (sourceFrames grande) → batch_index CAPPATO a 16384 (max ComfyUI, non 99999)', () => {
    // REGRESSIONE prod: passavamo 99999 → ComfyUI rifiuta il grafo
    // (value_bigger_than_max, max 16384) → 502 su /studio/extend-upload.
    const g = buildWanExtendGraph(extSpec({ scaleSourceToTarget: true, sourceFrames: 100000 }));
    expect(g.last!.inputs.batch_index).toBe(16384);
    expect(g.last!.inputs.batch_index).toBeLessThanOrEqual(16384);
  });

  it('🔴 batch_index non supera MAI 16384 (max ComfyUI ImageFromBatch)', () => {
    for (const sourceFrames of [1, 25, 16383, 16384, 16385, 50000, 1_000_000]) {
      const g = buildWanExtendGraph(extSpec({ sourceFrames }));
      expect(g.last!.inputs.batch_index).toBeLessThanOrEqual(16384);
      expect(g.last!.inputs.batch_index).toBeGreaterThanOrEqual(0);
    }
  });

  // Slow-motion ANCHE in estensione (era il gap: il rallentamento non aveva
  // effetto perché buildWanExtendGraph non aveva il ramo RIFE).
  it('slowmo assente/1: NESSUN interp, CreateVideo legge dal concat', () => {
    const g = buildWanExtendGraph(extSpec());
    expect(g.interp).toBeUndefined();
    expect(g.interpModel).toBeUndefined();
    expect(g.vid!.inputs.images).toEqual(['combined', 0]);
  });

  it('🚨 slowmo=2: interpola l\'INTERO concat (RIFE) → CreateVideo legge dall\'interp', () => {
    const g = buildWanExtendGraph(extSpec({ slowmo: 2 }));
    // MUTATION: senza appendSlowmo nell'extend → images resta ['combined',0] → rosso.
    expect(g.interpModel!.class_type).toBe('FrameInterpolationModelLoader');
    expect(g.interp!.class_type).toBe('FrameInterpolate');
    expect(g.interp!.inputs.images).toEqual(['combined', 0]); // interpola il video concatenato
    expect(g.interp!.inputs.multiplier).toBe(2);
    expect(g.vid!.inputs.images).toEqual(['interp', 0]);
    expect(g.vid!.inputs.fps).toEqual(['gvc', 2]); // fps del sorgente → durata ×2
  });

  it('slowmo oltre il max è clampato a 4 anche in extend', () => {
    expect(buildWanExtendGraph(extSpec({ slowmo: 99 })).interp!.inputs.multiplier).toBe(4);
  });
});

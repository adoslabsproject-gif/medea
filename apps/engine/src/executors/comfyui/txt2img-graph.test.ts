import { describe, it, expect } from 'vitest';
import { buildTxt2ImgGraph, type Txt2ImgParams } from './txt2img-graph.js';

const base: Txt2ImgParams = {
  checkpoint: 'model.safetensors',
  prompt: 'a cat',
  negative: 'blurry',
  width: 1024,
  height: 768,
  steps: 28,
  cfg: 7,
  sampler: 'euler',
  scheduler: 'normal',
  seed: 42,
  batchSize: 2,
  samplingMode: 'eps',
};

describe('buildTxt2ImgGraph', () => {
  it('costruisce il grafo base (eps): KSampler prende il MODEL dal checkpoint (4)', () => {
    const g = buildTxt2ImgGraph(base);
    expect(g['4']?.class_type).toBe('CheckpointLoaderSimple');
    expect(g['4']?.inputs.ckpt_name).toBe('model.safetensors');
    expect(g['3']?.class_type).toBe('KSampler');
    expect(g['3']?.inputs.model).toEqual(['4', 0]); // diretto dal checkpoint
    expect(g['10']).toBeUndefined(); // niente ModelSamplingDiscrete in eps
  });

  it('propaga prompt/negative/dimensioni/sampler/seed nei nodi giusti', () => {
    const g = buildTxt2ImgGraph(base);
    expect(g['6']?.inputs.text).toBe('a cat'); // positive
    expect(g['7']?.inputs.text).toBe('blurry'); // negative
    expect(g['5']?.inputs).toMatchObject({ width: 1024, height: 768, batch_size: 2 });
    expect(g['3']?.inputs).toMatchObject({ seed: 42, steps: 28, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 });
    expect(g['9']?.class_type).toBe('SaveImage');
  });

  it('v_prediction INSERISCE ModelSamplingDiscrete (10) e ci instrada il MODEL del sampler', () => {
    const g = buildTxt2ImgGraph({ ...base, samplingMode: 'v_prediction' });
    expect(g['10']?.class_type).toBe('ModelSamplingDiscrete');
    expect(g['10']?.inputs).toMatchObject({ sampling: 'v_prediction', model: ['4', 0] });
    expect(g['3']?.inputs.model).toEqual(['10', 0]); // il sampler passa per il 10, non per il 4
  });

  it('è serializzabile in JSON (nessun riferimento ciclico)', () => {
    expect(() => JSON.stringify(buildTxt2ImgGraph(base))).not.toThrow();
  });

  it('catena LoRA: model+clip passano per ogni LoRA in sequenza', () => {
    const g = buildTxt2ImgGraph({ ...base, loras: [{ name: 'a.safetensors', strengthModel: 0.8 }, { name: 'b.safetensors' }] });
    expect(g.lora0?.inputs.model).toEqual(['4', 0]);
    expect(g.lora0?.inputs.clip).toEqual(['4', 1]);
    expect(g.lora0?.inputs.strength_model).toBe(0.8);
    expect(g.lora1?.inputs.model).toEqual(['lora0', 0]); // catena
    expect(g['3']?.inputs.model).toEqual(['lora1', 0]);      // sampler dal LoRA finale
    expect(g['6']?.inputs.clip).toEqual(['lora1', 1]);       // CLIP post-LoRA
  });

  it('LoRA + v_prediction: il ModelSamplingDiscrete parte dal LoRA finale', () => {
    const g = buildTxt2ImgGraph({ ...base, samplingMode: 'v_prediction', loras: [{ name: 'a.safetensors' }] });
    expect(g['10']?.inputs.model).toEqual(['lora0', 0]);
    expect(g['3']?.inputs.model).toEqual(['10', 0]);
  });

  it('img2img: initImage → LoadImage+VAEEncode, latent dall\'encode, denoise <1, niente EmptyLatentImage', () => {
    const g = buildTxt2ImgGraph({ ...base, initImage: 'ref.png', denoise: 0.5 });
    expect(g.load?.class_type).toBe('LoadImage');
    expect(g.load?.inputs.image).toBe('ref.png');
    expect(g.encode?.class_type).toBe('VAEEncode');
    expect(g.encode?.inputs.pixels).toEqual(['load', 0]);
    expect(g['3']?.inputs.latent_image).toEqual(['encode', 0]);
    expect(g['3']?.inputs.denoise).toBe(0.5);
    expect(g['5']).toBeUndefined();
  });

  it('txt2img (no initImage): EmptyLatentImage + denoise 1', () => {
    const g = buildTxt2ImgGraph(base);
    expect(g['5']?.class_type).toBe('EmptyLatentImage');
    expect(g['3']?.inputs.latent_image).toEqual(['5', 0]);
    expect(g['3']?.inputs.denoise).toBe(1);
    expect(g.load).toBeUndefined();
  });

  it('img2img default denoise 0.6 se non specificato', () => {
    const g = buildTxt2ImgGraph({ ...base, initImage: 'ref.png' });
    expect(g['3']?.inputs.denoise).toBe(0.6);
  });

  it('hires-fix (txt2img): LatentUpscaleBy + 2° KSampler, VAEDecode dal 2° pass', () => {
    const g = buildTxt2ImgGraph({ ...base, hires: true });
    expect(g.up?.class_type).toBe('LatentUpscaleBy');
    expect(g.up?.inputs.samples).toEqual(['3', 0]);
    expect(g['3b']?.class_type).toBe('KSampler');
    expect(g['3b']?.inputs.latent_image).toEqual(['up', 0]);
    expect(g['8']?.inputs.samples).toEqual(['3b', 0]);
  });

  it('hires ignorato in img2img', () => {
    const g = buildTxt2ImgGraph({ ...base, hires: true, initImage: 'ref.png' });
    expect(g.up).toBeUndefined();
    expect(g['8']?.inputs.samples).toEqual(['3', 0]);
  });

  it('LoRA con nome vuoto/spazi → ignorato', () => {
    const g = buildTxt2ImgGraph({ ...base, loras: [{ name: '  ' }, { name: 'real.safetensors' }] });
    expect(g.lora1).toBeUndefined();        // il blank è scartato → resta solo lora0
    expect(g.lora0?.inputs.lora_name).toBe('real.safetensors');
    expect(g['3']?.inputs.model).toEqual(['lora0', 0]);
  });
});

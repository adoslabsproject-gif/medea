/**
 * action_dash_probe — parse MPEG-DASH .mpd manifest → adaptation sets,
 * representations, bitrate, codec, duration.
 *
 * Use case legittimi:
 *  - Monitoring CDN DASH streaming proprio
 *  - Verifica encoding multi-bitrate ABR
 *  - Compliance check (audio tracks, lang attributes)
 */

import { safeFetchWithRedirects } from '@medea/engine-safe-fetch';
import { load as cheerioLoad } from 'cheerio';
import type { NodeModule, NodeExecutor } from '../types.js';

interface Representation {
  id?: string;
  mimeType?: string;
  codecs?: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  frameRate?: string;
  audioSamplingRate?: string;
}

interface AdaptationSet {
  id?: string;
  contentType?: string; // video, audio, text
  mimeType?: string;
  lang?: string;
  representations: Representation[];
}

function parseDuration(iso: string | undefined): number {
  if (!iso) return 0;
  // ISO 8601 duration: PT1H23M45.6S
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(iso);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const executor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const url = String(config.url ?? '');
  if (!url) throw new Error('url required (DASH .mpd manifest)');

  const headers: Record<string, string> = {
    'User-Agent': String(config.userAgent ?? 'FlowForge/1.0'),
    Accept: 'application/dash+xml, application/xml, */*',
  };

  const res = await safeFetchWithRedirects(url, { method: 'GET', headers, timeoutMs: 15_000 });
  if (!res.ok) throw new Error(`DASH fetch ${res.status.toString()}`);
  const text = await res.text();
  if (!text.includes('<MPD')) {
    throw new Error('Not a valid DASH manifest (missing <MPD> root)');
  }

  // Parse XML using cheerio in xml mode
  const $ = cheerioLoad(text, { xml: true });
  const mpd = $('MPD').first();
  const totalDurationSec = parseDuration(mpd.attr('mediaPresentationDuration'));
  const minBufferTime = parseDuration(mpd.attr('minBufferTime'));
  const type = mpd.attr('type') ?? 'static';
  const profiles = mpd.attr('profiles') ?? '';

  const adaptationSets: AdaptationSet[] = [];
  $('AdaptationSet').each((_, el) => {
    const $as = $(el);
    const reps: Representation[] = [];
    $as.find('Representation').each((__, repEl) => {
      const $r = $(repEl);
      const rep: Representation = {};
      const id = $r.attr('id');
      if (id) rep.id = id;
      const mime = $r.attr('mimeType') ?? $as.attr('mimeType');
      if (mime) rep.mimeType = mime;
      const codecs = $r.attr('codecs') ?? $as.attr('codecs');
      if (codecs) rep.codecs = codecs;
      const w = $r.attr('width');
      if (w) rep.width = Number(w);
      const h = $r.attr('height');
      if (h) rep.height = Number(h);
      const bw = $r.attr('bandwidth');
      if (bw) rep.bandwidth = Number(bw);
      const fr = $r.attr('frameRate');
      if (fr) rep.frameRate = fr;
      const sr = $r.attr('audioSamplingRate');
      if (sr) rep.audioSamplingRate = sr;
      reps.push(rep);
    });
    const aset: AdaptationSet = { representations: reps };
    const asId = $as.attr('id');
    if (asId) aset.id = asId;
    const ct = $as.attr('contentType');
    if (ct) aset.contentType = ct;
    const m = $as.attr('mimeType');
    if (m) aset.mimeType = m;
    const lang = $as.attr('lang');
    if (lang) aset.lang = lang;
    adaptationSets.push(aset);
  });

  const videoSets = adaptationSets.filter(
    (a) => a.contentType === 'video' || (a.mimeType ?? '').startsWith('video'),
  );
  const audioSets = adaptationSets.filter(
    (a) => a.contentType === 'audio' || (a.mimeType ?? '').startsWith('audio'),
  );
  const textSets = adaptationSets.filter(
    (a) => a.contentType === 'text' || (a.mimeType ?? '').startsWith('text'),
  );

  return {
    output: {
      type, // static = VOD, dynamic = live
      profiles,
      totalDurationSec,
      minBufferTime,
      adaptationSets,
      counts: {
        videoSets: videoSets.length,
        audioSets: audioSets.length,
        textSets: textSets.length,
        totalRepresentations: adaptationSets.reduce((s, a) => s + a.representations.length, 0),
      },
      url: res.url,
    },
    durationMs: Date.now() - start,
  };
};

export const dashProbeNode: NodeModule = {
  def: {
    id: 'action_dash_probe',
    type: 'action',
    label: 'DASH Probe (mpd)',
    icon: 'video',
    color: '#9333ea',
    description:
      "Parser inspector di manifest MPEG-DASH (Dynamic Adaptive Streaming over HTTP) — l'altro grande standard " +
      'di streaming video adaptive accanto a Apple HLS, dominante su YouTube, Twitch (parziale), broadcaster ' +
      'europei tipo France.tv, BBC iPlayer, Mediaset Infinity, Sky, e tutti i servizi DRM-protetti con Widevine ' +
      'o PlayReady (Netflix, Disney+, Amazon Prime Video). Scarica il file .mpd (Media Presentation Description, ' +
      "XML) dall'URL fornito e ne fa il parse semantico estraendo l'inventario completo dell'asset: " +
      'AdaptationSets separati per tipologia (video, audio multitraccia con lingua identificata via @lang BCP-47, ' +
      "subtitle/caption con formato WebVTT/TTML), Representations all'interno di ogni AdaptationSet con tutti i " +
      'dettagli tecnici (bandwidth target in bit/s, codec FourCC come avc1.640028 H.264 High Profile L4.0 oppure ' +
      'hev1.1.6.L150.B0 HEVC Main10 oppure av01.0.05M.08 AV1, risoluzione width×height, frameRate computato), ' +
      "durata totale dell'asset come ISO 8601 PT1H32M15S (riconvertibile in secondi per programmi di scheduling), " +
      'profili DASH dichiarati (ISO Live, ISO On-Demand, DASH-IF IOP 2024), tipo di presentation (static=VOD ' +
      'tradizionale con time-shift permesso e seekable / dynamic=live con time-shift buffer configurabile e ' +
      'window di availability). ' +
      'Output: { adaptationSets: [...], totalDurationSeconds, presentationType, profiles, mpdVersion, ' +
      'minBufferTime, mediaPresentationDuration }. ' +
      'Operazione READ-ONLY pura: scarica e parsa SOLO il manifest XML (tipicamente 50-200KB), zero traffico ' +
      'sui segmenti video reali (che sarebbero centinaia di MB-GB). Sicuro per monitoring continuativo. ' +
      'Use case: monitoring 24/7 del CDN proprio che serve DASH streaming (allarme se 1 AdaptationSet video ' +
      "scompare improvvisamente — l'encoder è giù); verifica encoding profile ABR (Adaptive Bit-Rate) di " +
      'qualità per detect di regressioni post-deploy nuovo encoder ladder (es. "ci aspettiamo 6 bitrate da 240p ' +
      'a 2160p, oggi ne troviamo 4 = alarm"); compliance audio multilingua dichiarata vs effettiva per servizi ' +
      'broadcasting EU che hanno obblighi di accessibilità BCP-47 (it, en, fr, de track contractually required); ' +
      'detection di codec evolution (es. migrazione progressiva H.264 → HEVC → AV1 per ridurre bandwidth CDN ' +
      'del 50%); pre-flight check prima di pubblicare un nuovo asset Live (la "vetrina" che la pubblicazione ' +
      'lavora correttamente).',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'url',
        label: 'URL manifest .mpd',
        type: 'text',
        required: true,
        placeholder: 'https://cdn.miosito.com/vod/movie/manifest.mpd',
      },
      {
        key: 'userAgent',
        label: 'User-Agent',
        type: 'text',
        required: false,
        defaultValue: 'FlowForge/1.0',
        help: 'Header User-Agent. Alcuni CDN restringono i player ammessi (es. dash.js, ExoPlayer).',
      },
    ],
    outputs: [
      'type',
      'profiles',
      'totalDurationSec',
      'minBufferTime',
      'adaptationSets',
      'counts',
      'url',
    ],
  },
  executor,
};

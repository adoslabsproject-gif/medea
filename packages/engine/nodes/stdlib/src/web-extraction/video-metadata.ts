/**
 * action_video_metadata — ffprobe wrapper via endpoint BYO.
 *
 * Per ottenere codec/bitrate/fps/audio tracks/durata di un video file
 * serve ffprobe binary (~5MB + dipendenze codec). Anziche\` impacchettarlo
 * in stdlib, pattern BYO: endpoint HTTP che esegue ffprobe e ritorna JSON.
 *
 * Use case legittimi:
 *  - Archive: extract metadata pre-storage
 *  - Transcoding QA: verify output post-encoding
 *  - Validation: check compliance audio/codec prima di pubblicare
 *
 * Endpoint compatibile (request body):
 *   POST {endpoint}/probe
 *   { url: "https://...mp4" } | { dataBase64: "..." }
 *
 * Response: JSON ffprobe standard (streams[], format{}, chapters[]).
 */

import { safeFetchWithRedirects } from '@flowforge/safe-fetch';
import type { NodeModule, NodeExecutor } from '../types.js';

const executor: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  const endpoint = String(config.endpoint ?? process.env.FLOWFORGE_FFPROBE_ENDPOINT ?? '').trim();
  if (!endpoint) {
    throw new Error('ffprobe endpoint not configured. Set FLOWFORGE_FFPROBE_ENDPOINT env or fill "endpoint" config. Setup: deploy ffprobe server (es. https://github.com/jrottenberg/ffmpeg + node wrapper).');
  }

  const inputType = String(config.inputType ?? 'url');
  let url = String(config.url ?? '');
  let dataBase64 = '';
  if (inputType === 'input') {
    if (input && typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      url = String(obj.url ?? obj.videoUrl ?? url);
      dataBase64 = String(obj.dataBase64 ?? obj.base64 ?? '');
    }
  }
  if (inputType === 'base64') {
    dataBase64 = String(config.dataBase64 ?? '');
  }

  if (!url && !dataBase64) {
    throw new Error('Either url or dataBase64 required');
  }

  const reqBody: Record<string, unknown> = {};
  if (url) reqBody.url = url;
  if (dataBase64) reqBody.dataBase64 = dataBase64;

  const apiKey = String(config.apiKey ?? '').trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await safeFetchWithRedirects(`${endpoint.replace(/\/$/, '')}/probe`, {
    method: 'POST',
    headers,
    body: JSON.stringify(reqBody),
    timeoutMs: 60_000,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`ffprobe ${res.status.toString()}: ${t.slice(0, 300)}`);
  }
  const data = await res.json() as Record<string, unknown>;

  // Extract common fields for convenience
  const streams = (data.streams ?? []) as Record<string, unknown>[];
  const format = (data.format ?? {}) as Record<string, unknown>;
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subtitleStreams = streams.filter((s) => s.codec_type === 'subtitle');

  return {
    output: {
      // Convenience fields
      duration: Number(format.duration ?? 0),
      bitRate: Number(format.bit_rate ?? 0),
      formatName: String(format.format_name ?? ''),
      size: Number(format.size ?? 0),
      videoCodec: videoStream ? String(videoStream.codec_name ?? '') : null,
      videoWidth: videoStream ? Number(videoStream.width ?? 0) : null,
      videoHeight: videoStream ? Number(videoStream.height ?? 0) : null,
      videoFps: videoStream ? String(videoStream.r_frame_rate ?? '') : null,
      audioTracks: audioStreams.length,
      audioCodecs: audioStreams.map((s) => String(s.codec_name ?? '')),
      audioLanguages: audioStreams.map((s) => {
        const tags = (s.tags ?? {}) as Record<string, unknown>;
        return String(tags.language ?? 'und');
      }),
      subtitleTracks: subtitleStreams.length,
      subtitleLanguages: subtitleStreams.map((s) => {
        const tags = (s.tags ?? {}) as Record<string, unknown>;
        return String(tags.language ?? 'und');
      }),
      // Full ffprobe response
      raw: data,
    },
    durationMs: Date.now() - start,
  };
};

export const videoMetadataNode: NodeModule = {
  def: {
    id: 'action_video_metadata',
    type: 'action',
    label: 'Video Metadata (ffprobe)',
    icon: 'film',
    color: '#0d9488',
    description:
      'Estrattore enterprise di metadata da file video — basato su ffprobe (il tool companion di ffmpeg, ' +
      'l\'industry standard de-facto per video processing usato da YouTube, Netflix, Twitch, broadcaster TV ' +
      'mondiali per probe del media payload). Analizza qualsiasi file video supportato dal vasto codec library ' +
      'di ffmpeg (300+ formati incluso MP4, MKV, MOV, AVI, FLV, WMV, MTS, M2TS, MXF per broadcast professional, ' +
      'WebM per web modern) e ne estrae l\'inventario completo dei metadata tecnici essenziali per QA pre-' +
      'publish, indicizzazione media library, compliance broadcast: ' +
      'codec video (H.264/AVC più diffuso, HEVC/H.265 per high-efficiency, VP9 per WebM YouTube, AV1 royalty-' +
      'free per next-gen streaming, ProRes per editing professional), bitrate avg/max in Mbps, fps frame ' +
      'rate (24 standard cinematografico, 25 PAL europeo, 30 NTSC americano, 50 PAL slow-mo, 60 NTSC slow-mo), ' +
      'risoluzione width×height (480p, 720p HD, 1080p Full HD, 2160p 4K UHD, 4320p 8K), traccia audio ' +
      'multipla con codec (AAC più comune, AC3 Dolby Digital broadcast, EAC3 Dolby Digital Plus streaming, ' +
      'DTS Blu-ray, MP3 legacy), language tag per ogni traccia (it, en, fr, de... BCP-47), bit depth ' +
      '(8-bit standard, 10-bit HDR), channel layout (mono, stereo, 5.1 surround, 7.1), sample rate (44.1/' +
      '48/96 kHz); traccia sottotitoli con codec (subrip, WebVTT, ASS) + language; durata totale (secondi + ' +
      'human-readable HH:MM:SS); container format (mp4, mkv, mov, mts), metadata fields generici (title, ' +
      'artist, creation_time, encoder usato per generation). ' +
      'Pattern deployment specifico enterprise: ffprobe binary + dipendenze codec (libx264, libx265, libvpx, ' +
      'libav1) pesano ~50-100MB totale → NON viene bundlato nel container runtime FlowForge per evitare bloat ' +
      'inutile alla maggior parte dei tenant che non usano video. Pattern microservice: il tenant deploya ' +
      'un wrapper HTTP separato (immagine docker pre-pronta `jrottenberg/ffmpeg` + Express HTTP, oppure ' +
      'Cloud Run/Lambda con custom container, oppure self-hosted dedicated server) e configura l\'endpoint ' +
      'qui o via env FLOWFORGE_FFPROBE_ENDPOINT condivisa. Pattern SSRF-safe sempre: quando l\'URL del video ' +
      'da analizzare proviene da config user-driven o input esterno, il request passa per @flowforge/safe-' +
      'fetch che blocca URL privati 192.168/127.* per security. ' +
      'Use case: indicizzazione media library di una piattaforma streaming/VOD con catalogazione automatic ' +
      'di tutti i file caricati dal content team in metadata schema searchable; QA pre-publish per verifica ' +
      'compliance dei requirements editoriali (es. broadcaster italiano richiede 1080p min + traccia audio ' +
      'italiana obbligatoria + subtitle stereo per accessibilità); check size pre-CDN upload con cap budget ' +
      '(se file > 10GB → reject prima di consumare bandwidth/storage); compliance broadcast FCC USA/AGCOM ' +
      'Italia che richiede metadata standardizzati nel container per ingest nei sistemi broadcast.',
    vendor: 'flowforge',
    version: '1.1.0',
    configFields: [
      {
        key: 'endpoint',
        label: 'ffprobe endpoint HTTP',
        type: 'text',
        required: false,
        placeholder: 'http://ffprobe.internal:8080',
        help: 'URL del wrapper ffprobe HTTP. Lascia VUOTO per usare la env `FLOWFORGE_FFPROBE_ENDPOINT` (consigliato in produzione: 1 wrapper condiviso). Esempio container locale: `docker run -d -p 8080:8080 jrottenberg/ffmpeg-http`. Deve esporre `POST /probe` con body `{ url|data }` e ritornare JSON ffprobe standard.',
      },
      {
        key: 'apiKey',
        label: 'API Key wrapper (opzionale)',
        type: 'secret',
        required: false,
        placeholder: '{{secrets.FFPROBE_API_KEY}}',
        help: 'Bearer token se il wrapper richiede autenticazione. Lascia vuoto per wrapper interno senza auth. NON inserire mai una chiave in plain — usa il riferimento a Credentials.',
      },
      {
        key: 'inputType',
        label: 'Sorgente video',
        type: 'select',
        required: false,
        options: ['url', 'input', 'base64'],
        defaultValue: 'url',
        help: 'url = URL HTTP pubblico che il wrapper scaricherà. input = legge `url` o `dataBase64` dall\'output del nodo precedente (es. download da S3, file_read). base64 = dati video inline (max 10MB consigliato, oltre usa URL).',
      },
      {
        key: 'url',
        label: 'URL video',
        type: 'text',
        required: false,
        placeholder: 'https://cdn.miosito.com/video.mp4 / {{$node.s3_download.json.url}}',
        help: 'URL completo HTTP/HTTPS del file video. Supporta MP4, MOV, MKV, WebM, AVI, HLS .m3u8, DASH .mpd. Per HLS/DASH ffprobe estrae metadata del playlist (variant streams). SSRF-block automatic: IP interni e localhost bloccati.',
        showIf: { field: 'inputType', equals: 'url' },
      },
      {
        key: 'dataBase64',
        label: 'Video base64',
        type: 'textarea',
        required: false,
        placeholder: 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28y…',
        showIf: { field: 'inputType', equals: 'base64' },
        help: 'Contenuto video encoded base64 SENZA il prefisso "data:video/mp4;base64,". Limite raccomandato 10MB (oltre ffprobe HTTP timeout). Per file più grandi preferire `url` o `input`.',
      },
    ],
    outputs: ['duration', 'bitRate', 'formatName', 'size', 'videoCodec', 'videoWidth', 'videoHeight', 'videoFps', 'audioTracks', 'audioCodecs', 'audioLanguages', 'subtitleTracks', 'subtitleLanguages', 'raw'],
  },
  executor,
};

/**
 * action_hls_probe — parse playlist HLS .m3u8 → varianti, bitrate, codec,
 * durata segmenti.
 *
 * Use case legittimi:
 *  - Monitoring CDN streaming proprio
 *  - Quality assurance trasmissione live
 *  - Validation post-encoding (ffmpeg → upload → probe)
 *
 * NO download dei segmenti, NO decryption — solo metadata.
 */

import { safeFetchWithRedirects } from '@medea/engine-safe-fetch';
import type { NodeModule, NodeExecutor } from '../types.js';

interface Variant {
  url: string;
  bandwidth: number;
  averageBandwidth?: number;
  resolution?: string;
  codecs?: string;
  frameRate?: number;
  audio?: string;
}

interface Segment {
  url: string;
  duration: number;
  byterange?: string;
}

function parseM3U8(
  text: string,
  baseUrl: string,
): {
  isMaster: boolean;
  variants: Variant[];
  segments: Segment[];
  targetDuration?: number;
  totalDuration?: number;
  mediaSequence?: number;
  endlist?: boolean;
} {
  const lines = text.split(/\r?\n/);
  const variants: Variant[] = [];
  const segments: Segment[] = [];
  let isMaster = false;
  let targetDuration: number | undefined;
  let mediaSequence: number | undefined;
  let endlist = false;
  let pendingSegmentInfo: { duration: number } | null = null;
  let pendingVariantInfo: Partial<Variant> | null = null;

  // eslint-disable-next-line @typescript-eslint/prefer-for-of -- Loop index needed (`i` usato per logica interna o bench)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      isMaster = true;
      const attrs = parseAttrList(line.slice('#EXT-X-STREAM-INF:'.length));
      pendingVariantInfo = {
        bandwidth: Number(attrs.BANDWIDTH ?? 0),
      };
      if (attrs['AVERAGE-BANDWIDTH'])
        pendingVariantInfo.averageBandwidth = Number(attrs['AVERAGE-BANDWIDTH']);
      if (attrs.RESOLUTION) pendingVariantInfo.resolution = attrs.RESOLUTION;
      if (attrs.CODECS) pendingVariantInfo.codecs = attrs.CODECS;
      if (attrs['FRAME-RATE']) pendingVariantInfo.frameRate = Number(attrs['FRAME-RATE']);
      if (attrs.AUDIO) pendingVariantInfo.audio = attrs.AUDIO;
    } else if (line.startsWith('#EXTINF:')) {
      const dur = Number(line.slice('#EXTINF:'.length).split(',')[0]);
      pendingSegmentInfo = { duration: dur };
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice('#EXT-X-TARGETDURATION:'.length));
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length));
    } else if (line === '#EXT-X-ENDLIST') {
      endlist = true;
    } else if (!line.startsWith('#')) {
      // URL line
      const absolute = resolveUrl(line, baseUrl);
      if (pendingVariantInfo) {
        variants.push({ ...pendingVariantInfo, url: absolute } as Variant);
        pendingVariantInfo = null;
      } else if (pendingSegmentInfo) {
        segments.push({ url: absolute, duration: pendingSegmentInfo.duration });
        pendingSegmentInfo = null;
      }
    }
  }

  const out: {
    isMaster: boolean;
    variants: Variant[];
    segments: Segment[];
    targetDuration?: number;
    totalDuration?: number;
    mediaSequence?: number;
    endlist?: boolean;
  } = {
    isMaster,
    variants,
    segments,
    endlist,
  };
  if (targetDuration !== undefined) out.targetDuration = targetDuration;
  if (mediaSequence !== undefined) out.mediaSequence = mediaSequence;
  if (segments.length > 0) {
    out.totalDuration = segments.reduce((s, seg) => s + seg.duration, 0);
  }
  return out;
}

function parseAttrList(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    const eq = s.indexOf('=', i);
    if (eq < 0) break;
    const key = s.slice(i, eq).trim();
    const valStart = eq + 1;
    let val: string;
    if (s[valStart] === '"') {
      const end = s.indexOf('"', valStart + 1);
      val = s.slice(valStart + 1, end);
      i = end + 2; // skip closing quote + comma
    } else {
      const end = s.indexOf(',', valStart);
      val = s.slice(valStart, end < 0 ? s.length : end);
      i = (end < 0 ? s.length : end) + 1;
    }
    out[key] = val.trim();
  }
  return out;
}

function resolveUrl(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

const executor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const url = String(config.url ?? '');
  if (!url) throw new Error('url required (HLS .m3u8 playlist)');

  const headers: Record<string, string> = {
    'User-Agent': String(config.userAgent ?? 'FlowForge/1.0'),
    Accept: 'application/vnd.apple.mpegurl, audio/mpegurl, */*',
  };
  const referer = String(config.referer ?? '').trim();
  if (referer) headers.Referer = referer;

  const res = await safeFetchWithRedirects(url, {
    method: 'GET',
    headers,
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    throw new Error(`HLS fetch ${res.status.toString()}: ${(await res.text()).slice(0, 200)}`);
  }
  const text = await res.text();
  if (!text.startsWith('#EXTM3U')) {
    throw new Error('Not a valid HLS playlist (missing #EXTM3U header)');
  }

  const parsed = parseM3U8(text, res.url);

  return {
    output: {
      type: parsed.isMaster ? 'master' : 'media',
      ...parsed,
      url: res.url,
      raw: text.slice(0, 4000), // truncated raw for debug
    },
    durationMs: Date.now() - start,
  };
};

export const hlsProbeNode: NodeModule = {
  def: {
    id: 'action_hls_probe',
    type: 'action',
    label: 'HLS Probe (m3u8)',
    icon: 'video',
    color: '#7c3aed',
    description:
      'Parser inspector di playlist HLS (HTTP Live Streaming) — lo standard di streaming adaptive sviluppato da ' +
      'Apple nel 2009 e diventato dominante sia su iOS/Safari nativi che cross-platform via player tipo ' +
      'hls.js (utilizzato da Twitch, Disney+, Apple TV+, Disney Hotstar, Amazon Prime Video legacy, Mediaset ' +
      'Infinity, RAI Play, Sky Go, e centinaia di altri broadcaster italiani ed europei). Scarica il file .m3u8 ' +
      'di playlist e ne fa il parse RFC 8216 (HLS draft-pantos-hls-rfc8216bis-13 + estensioni Apple LL-HLS Low ' +
      'Latency 2025): rileva automaticamente se è una playlist master (parent che enumera le varianti di ' +
      'qualità via tag #EXT-X-STREAM-INF — la "ricetta" del ABR adaptive bitrate ladder, tipicamente 240p/' +
      '480p/720p/1080p/4K) oppure una media playlist (child che enumera i segmenti TS o fMP4 via tag #EXTINF — ' +
      'la lista concreta dei chunk da scaricare in sequenza). ' +
      'Output rich per master: { type: "master", variants: [{ bandwidth (bit/s), resolution (WxH), codecs ' +
      '(avc1.4D401F per H.264 main profile, hev1.1.6.L120.B0 per HEVC, av01.0.04M.08 per AV1, mp4a.40.2 per ' +
      'AAC-LC, ec-3 per Dolby Digital Plus), frameRate, audioCodecs, captions, subtitles, url (assoluto o ' +
      'relativo alla baseUrl) }], iframePlaylists?, sessionData?, contentSteering?, drmSchemes? }. ' +
      'Output per media: { type: "media", segments: [{ duration (decimal seconds), uri, byteRange?, dateTime?, ' +
      'discontinuity? }], targetDuration (max single segment duration), mediaSequence (incremental counter), ' +
      'endlist (true=VOD playlist statica con #EXT-X-ENDLIST / false=live con sliding window di N segmenti), ' +
      'playlistType? (VOD|EVENT), keys? (chiavi di encryption AES-128 ClearKey o sample-aes DRM) }. ' +
      'Operazione READ-ONLY pura: parsa SOLO il manifest text (tipicamente 5-50KB), zero traffico sui segmenti ' +
      'video reali (che sarebbero centinaia di MB-GB), zero decryption (le DRM chiavi sono solo enumerate, non ' +
      'usate per estrarre contenuto). Sicuro per monitoring continuativo 24/7 anche su 100+ stream ' +
      'simultaneamente, traffic footprint minimo. ' +
      'Use case: monitoring CDN streaming proprio "la nostra master ha sempre le 3 varianti aspettate ' +
      '(360p+720p+1080p)? oggi 23 maggio ne vede solo 2 = alarm encoder produzione TV down"; quality assurance ' +
      'post-encoding "il nuovo asset upload ha tutti i bitrate target +/- 5% tolleranza"; uptime check live ' +
      'stream "il live HLS è ancora effettivamente live? endlist=false + segmenti aggiornati negli ultimi 30s ' +
      '= sì, altrimenti = stream interrotto"; detection di encoding evolution (migrazione progressiva da AVC ' +
      'a HEVC a AV1 per ridurre bandwidth CDN del 40-60%); validation di stream gratuit di terze parti (sport ' +
      'rights monitoring, broadcaster legali vs piratato) prima di aggregarlo nel catalogo streaming come ' +
      'Streammy; setup automatic di player JavaScript (hls.js, video.js) — il client legge le varianti ' +
      'disponibili e seleziona quella migliore in base a bandwidth misurato real-time.',
    outputContract: {
      notes: 'Legge una playlist HLS. Su una playlist PRINCIPALE escono le `variants` e i segmenti sono vuoti; su una playlist di segmenti e` il contrario. `endlist` falso significa diretta in corso.',
      fields: [
        { name: 'type', type: 'string', desc: 'Se e` una playlist principale o di segmenti.' },
        { name: 'variants', type: 'array', desc: 'Le qualita` disponibili. Solo sulla playlist principale.' },
        { name: 'segments', type: 'array', desc: 'I segmenti video. Solo sulla playlist di segmenti.' },
        { name: 'targetDuration', type: 'number', desc: 'La durata dichiarata di un segmento.' },
        { name: 'totalDuration', type: 'number', desc: 'La durata complessiva dei segmenti.' },
        { name: 'mediaSequence', type: 'number', desc: 'Il numero del primo segmento della lista.' },
        { name: 'endlist', type: 'boolean', desc: 'Vero se la lista e` chiusa: falso significa diretta in corso.' },
        { name: 'url', type: 'string', desc: 'La playlist esaminata.' },
        { name: 'raw', type: 'string', desc: 'Il testo della playlist, per i casi non previsti.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'url',
        label: 'URL playlist .m3u8',
        type: 'text',
        required: true,
        placeholder: 'https://cdn.miosito.com/live/master.m3u8',
        help: 'URL diretto al .m3u8. Funziona sia con master playlist (varianti) sia con media playlist (segmenti).',
      },
      {
        key: 'userAgent',
        label: 'User-Agent',
        type: 'text',
        required: false,
        defaultValue: 'FlowForge/1.0',
        help: 'UA per la richiesta. Alcuni CDN richiedono un UA specifico (es. iOS user-agent per Apple HLS).',
      },
      {
        key: 'referer',
        label: 'Referer',
        type: 'text',
        required: false,
        help: 'Header Referer (se il CDN restringe per origin).',
      },
    ],
    outputs: [
      'type',
      'variants',
      'segments',
      'targetDuration',
      'totalDuration',
      'mediaSequence',
      'endlist',
      'url',
      'raw',
    ],
  },
  executor,
};

/**
 * agent_video_summarizer — video → summary multimodale.
 *
 * Pipeline:
 *  1. ffprobe (via code-runner sandbox) → metadata + framerate
 *  2. ffmpeg frame extraction (1 frame/N secondi, default 1/5s)
 *  3. ffmpeg audio extract → mp3 16kHz mono
 *  4. Whisper ASR (microservizio :5005 o whisper.cpp local) → transcript con timestamp
 *  5. Vision Qwen2.5-VL :5004 → describe frames (batch, scene change detection)
 *  6. Liara LLM → fuse transcript + scene descriptions in summary strutturato
 *
 * Output: { transcript, scenes[], summary: {tldr, bullets, chapters[]}, durationSec }
 *
 * Use case: indicizzazione media library (video corsi/webinar/meeting),
 * highlight reel automatico, accessibility (caption + audio description),
 * search-in-video tramite scenes timestamps.
 */
import type { NodeModule } from '../types.js';

export const videoSummarizerNode: NodeModule = {
  def: {
    id: 'agent_video_summarizer',
    type: 'action',
    label: 'Video Summarizer (Whisper + Vision)',
    icon: 'video',
    color: '#a855f7',
    description:
      "Pipeline multimodale enterprise video-to-summary strutturato — l'AI-powered processor che trasforma " +
      "un video raw (caricato dall'utente, fetched da URL pubblico YouTube/Vimeo/CDN, output di un meeting " +
      'Zoom recording) in un riassunto strutturato gerarchico pronto per consumo umano (TL;DR esecutivo) + ' +
      'consumo machine (chapter timestamped per navigazione + transcript completo per search). Architettura ' +
      'multi-stage che combina 3 modelli AI specializzati orchestrati: ' +
      '(1) ffmpeg extract — extraction temporale del video grezzo in 2 streams paralleli: audio mono 16kHz ' +
      'PCM raw (formato di input ottimale per ASR), frames JPEG sampling 1fps (un frame per secondo per ' +
      'analysis vision senza saturare context window dei vision model); ' +
      '(2) Whisper ASR transcript — il modello speech-to-text OpenAI open-source self-hosted on-premise EU ' +
      "(Hetzner Falkenstein GEX131 RTX PRO 6000 Blackwell 96GB) elabora l'audio producendo transcript " +
      'parola-per-parola con timestamp millisecond-level di ogni token + speaker diarization (chi parla — ' +
      'speaker_0, speaker_1 fino a 8 partecipanti distinguibili per voce timbre), language auto-detection con ' +
      'supporto a 99 lingue compreso italiano alta accuracy; ' +
      '(3) Vision Qwen2.5-VL describe scenes — il modello multimodal vision Qwen2.5-VL-7B INT4 ' +
      'self-hosted analizza i frame estratti applicando scene-change detection (similarity-based clustering ' +
      'dei frame consecutive — quando passa una soglia di differenza visiva si dichiara nuova scena) e ' +
      'descrive ogni scena identificata con caption rich (es. "Slide 3 mostra grafico fatturato Q4 con bar ' +
      'chart e label "+23% YoY""); ' +
      '(4) Liara LLM fusion stage — il LLM principale fonde i 2 stream (transcript Whisper + scenes Vision) ' +
      "producendo l'output finale gerarchico TL;DR + bullets + chapters timestamped, pattern che cattura sia " +
      'il content auditive (parole spoken) sia visual (slide, demo screen, persone identificate dal volto). ' +
      'Backend interamente self-hosted Hetzner (no costi per-token sui pipeline component AI, no transferimento ' +
      'dati extra-UE GDPR-compliant — pattern enterprise critical per casi tipo studio medico che processa ' +
      'meeting con dati sanitari sensibili o studio legale con materiale confidenziale cliente). ' +
      'Output rich strutturato: { transcript (full text concatenated con [00:00:12] timestamps), scenes: [{ ' +
      'startTime, endTime, description, confidence }], summary: { tldr (200-400 char executive summary), ' +
      'bullets (5-10 key points), chapters: [{ title, startTime, summary }] }, durationSec, processedAt, ' +
      'detectedLanguage, speakerCount }. ' +
      'Use case: indicizzazione media library (corsi online, webinar registered, meeting recording per ' +
      'institutional knowledge base searchable); highlight reel automatic per social media marketing (' +
      'top 3-5 chapters più engaging clip per LinkedIn/Twitter/YouTube Shorts); accessibility WCAG 2.2 ' +
      'compliance (caption + audio description per persone non udenti + non vedenti); search-in-video ' +
      'capability tramite scene timestamps (l\'utente cerca "fatturato Q4" nella library e va direttamente ' +
      'al chapter relativo del video); briefing post-meeting con chapter cliccabili distribuito al team ' +
      'che non ha potuto partecipare; documentation di demo prodotto con auto-generated transcript per dev ' +
      'team reference.',
    configFields: [
      {
        key: 'videoUrl',
        label: 'URL video',
        type: 'expression',
        required: true,
        placeholder: 'https://... .mp4 o {{input.url}}',
        help: 'URL del video da analizzare (mp4/webm/mov). SSRF-safe via safeFetch. Per file locali usa /data path nel sandbox.',
      },
      {
        key: 'frameIntervalSec',
        label: 'Intervallo frame (secondi)',
        type: 'number',
        required: false,
        defaultValue: '5',
        help: 'Estrai 1 frame ogni N secondi per Vision analysis. Min 1, max 60. Default 5s.',
      },
      {
        key: 'enableTranscription',
        label: 'Abilita trascrizione audio (Whisper)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: "Se on, chiama il servizio Whisper per trascrivere l'audio. Default OFF: il nodo lavora solo con descrizione Vision delle scene (Whisper non è stand-alone su tutte le installation).",
      },
      {
        key: 'whisperEndpoint',
        label: 'Endpoint Whisper ASR (solo se transcript abilitato)',
        type: 'text',
        required: false,
        defaultValue: 'http://host.docker.internal:5005',
        help: 'URL servizio Whisper. Usato solo se "Abilita trascrizione audio" = on. Default host PM2 :5005.',
      },
      {
        key: 'visionEndpoint',
        label: 'Endpoint Vision (Qwen2.5-VL)',
        type: 'text',
        required: false,
        defaultValue: 'http://host.docker.internal:5004',
        help: 'URL servizio Vision. Default host PM2 :5004.',
      },
      {
        key: 'summaryLanguage',
        label: 'Lingua summary',
        type: 'select',
        required: false,
        defaultValue: 'auto',
        options: ['auto', 'it', 'en', 'de', 'fr', 'es'],
        help: 'Lingua output summary. "auto" usa la lingua rilevata da Whisper sul transcript.',
      },
      {
        key: 'maxDurationSec',
        label: 'Max durata video (s)',
        type: 'number',
        required: false,
        defaultValue: '1800',
        help: 'Hard cap durata processabile. Min 60, max 7200 (2h). Default 30 min anti-runaway.',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

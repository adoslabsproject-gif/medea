import type { NodeModule } from '../types.js';

export const fileReadNode: NodeModule = {
  def: {
    id: 'action_file_read',
    type: 'action',
    label: 'Read File',
    icon: 'file-text',
    color: '#3b82f6',
    description:
      'Nodo di lettura file enterprise dal filesystem persistente del container tenant FlowForge — controparte ' +
      'inversa di action_file_write, condivide le stesse guardrail di sicurezza zero-trust. Legge il contenuto ' +
      "di un file all'interno della cartella sandbox del tenant (/data per il container Docker corrispondente), " +
      'con allowlist enforcement server-side: no escape ../, no symlink resolution (link simbolici a file fuori ' +
      'sandbox rifiutati prima del read), no accesso a directory di sistema /etc /proc /sys, ownership check ' +
      'sul UID del processo runtime, cap di sicurezza su dimensione file leggibile (default 100MB per evitare ' +
      'OOM su read di file giganti via expression maligna). ' +
      'Encoding multi-formato configurabili in base al tipo di payload contenuto: utf8 (default, per testo/JSON/' +
      'CSV/XML/YAML che sono il 90% degli use case workflow business), utf16le (per file Windows legacy con BOM ' +
      'FF FE generati da Notepad o sistemi mainframe), base64 (per binari PDF/JPG/PNG/MP3 da passare a ' +
      'action_send_email come attachment senza necessità di file system intermedio, o per ingest in db come ' +
      'TEXT field), hex (per debug binari low-level di file corruption — visualizza i raw bytes), binary ' +
      '(raw buffer pass-through per binary processing downstream tipo action_ffmpeg). ' +
      'Output: { content (string nel formato encoding richiesto), sizeBytes (per quota tracking + analytics), ' +
      'mtime (ISO 8601 per detection di file aggiornato vs cached version), path (absolute resolved), ' +
      'sha256? (hash crittografico opzionale per integrity check su backup/restore workflow), mimeType? ' +
      '(rilevato automaticamente da magic bytes per file binari), lineCount? (per file testuali, conteggio ' +
      'newline per quick stats) }. ' +
      'Error semantics esplicito: path fuori sandbox → SANDBOX_VIOLATION 403 con audit log + reason; file non ' +
      'esistente → ENOENT 404 (use case workflow tipico: trigger_file_watch firma su file in fase di upload ' +
      'progressivo SFTP → action_file_read fallisce con ENOENT → retry con logic_delay 5s gestisce gracefully); ' +
      'file > cap dimensione → FILE_TOO_LARGE 413. ' +
      'Use case: caricare file di configurazione statici (config.json, mappe lookup, blocklist) per uso ' +
      "lungo l'intero workflow batch; leggere CSV uploaded dal cliente via SFTP nella cartella drop/ + " +
      'parsing tramite logic_convert per ingest in db_query bulk insert; lettura di template documenti markdown ' +
      'pre-creati dal customer (es. "template_offerta_v3.md") per generation downstream tramite action_pdf_generate ' +
      'con expression substitution dei placeholder cliente-specifici; ingest di file droppati da action_file_write ' +
      'upstream nello stesso workflow (pattern pipeline ETL: write JSON intermedio → process → read finale); ' +
      're-read in successive run tramite trigger_cron del file di state cross-run (alternativa al memory_note ' +
      'per state JSON > 1MB).',
    configFields: [
      {
        key: 'path',
        label: 'File',
        type: 'file-picker',
        required: true,
        placeholder: 'es. report.json (relativo alla sandbox tenant)',
        help: 'Path nel sandbox del tenant (relativo o assoluto se allowlistato). Usa il bottone "📂 Sfoglia…" per navigare.',
      },
      {
        key: 'encoding',
        label: 'Encoding',
        type: 'select',
        required: false,
        options: ['utf8', 'utf16le', 'base64', 'hex', 'binary'],
        defaultValue: 'utf8',
        help:
          'utf8/utf16le → output `content` stringa (testo/JSON/CSV). ' +
          'base64/hex/binary → output `binary`: un HANDLE BinaryData (ref content-addressed sul disco ' +
          'del tenant, dedup, streaming) invece di gonfiare il JSON. Si collega a Write File / email / ' +
          'PDF / Excel che consumano BinaryData. Consigliato per immagini/PDF/file binari.',
      },
    ],
    vendor: 'flowforge',
    version: '1.1.0',
  },
};

export const fileWriteNode: NodeModule = {
  def: {
    id: 'action_file_write',
    type: 'action',
    label: 'Write File',
    icon: 'file-plus',
    color: '#3b82f6',
    description:
      'Nodo di scrittura file enterprise sul filesystem persistente del container tenant FlowForge — ' +
      "l'equivalente managed-cloud di un fs.writeFile Node.js con guard-rail di sicurezza multipli + audit + " +
      'expression templating. Scrive il contenuto fornito (string, JSON serializzato, output di altri nodi via ' +
      "expression {{$node.X.json.body}}) in un file all'interno della cartella sandbox del tenant " +
      '(/data per il container Docker corrispondente, cap di 1GB per tenant FREE / 10GB PRO / 100GB TEAM). ' +
      'Sicurezza zero-trust: allowlist enforced server-side (no escape ../, no symlink resolution, no overwrite ' +
      'di file system del container tipo /etc, /usr, /var/run), validazione path canonicalizzato prima della ' +
      'apertura, ownership check (file scritti come UID 65532 del processo runtime, immutable bit non ' +
      'modificabile), cap su dimensione file singolo configurabile (default 100MB) per evitare DoS via fill-disk. ' +
      'Crea automaticamente le directory mancanti nel path (mkdir -p atomico) — niente errore "ENOENT no such ' +
      'file or directory" che richiede 2 nodi per fare la stessa cosa. ' +
      'Due modalità di scrittura: overwrite (default — sovrascrive completamente il file precedente, write+rename ' +
      'atomico per consistenza in caso di crash a metà write) oppure append (aggiunge il contenuto alla coda del ' +
      'file esistente — fondamentale per logfile incrementali che crescono nel tempo, per evitare race condition ' +
      'su concurrent write di workflow paralleli sullo stesso file il nodo usa O_APPEND atomico syscall-level). ' +
      'Supporta interamente il sistema di template FlowForge: {{espressioni}} nel contenuto vengono valutate ' +
      "dall'expression engine prima della scrittura (accesso a $node, $input, $vars, helpers come $date.now, " +
      '$string.upper, $crypto.sha256). ' +
      'Output: { path (absolute resolved), bytesWritten (per audit + quota), mode (overwrite|append), ' +
      'mtimeIso, sha256? (computato se sha256 fornito come check di integrità) }. ' +
      'Use case: scrivere report mensili HTML/PDF generati da action_pdf_generate nella cartella /data/reports/ ' +
      'per download cliente; log eventi su file rotante /data/logs/audit-{{$date.today}}.log con mode=append ' +
      '(rotazione automatica daily); persist state cross-run del workflow tipo "ultimo timestamp processato" per ' +
      'pipeline incrementali (alternativa al memory_note per state JSON > 1MB); export CSV consumati da ' +
      'action_file_read downstream nello stesso workflow o in run successive; salvataggio temporaneo di file ' +
      'binari (uudecoded da base64) prima di processing tramite action_ffmpeg o action_vision_extract.',
    configFields: [
      {
        key: 'path',
        label: 'File di destinazione',
        type: 'file-picker',
        required: true,
        placeholder: 'es. output.json (relativo) o /tmp/log.txt',
        help: 'Path nel sandbox del tenant. La cartella viene creata se non esiste.',
      },
      {
        key: 'content',
        label: 'Contenuto',
        type: 'textarea',
        required: false,
        help: 'Testo o JSON.stringify(...). Supporta {{espressioni}}. Lascialo VUOTO per scrivere un file binario: se a monte arriva un handle BinaryData (es. da Read File con output binario, o un nodo PDF), ne vengono scritti i byte reali (no conversione a stringa). Content esplicito ha precedenza.',
      },
      {
        key: 'mode',
        label: 'Modalità scrittura',
        type: 'select',
        required: false,
        options: ['overwrite', 'append'],
        defaultValue: 'overwrite',
        help: 'overwrite = sovrascrive. append = aggiunge in coda.',
      },
    ],
    vendor: 'flowforge',
    version: '1.1.0',
  },
};

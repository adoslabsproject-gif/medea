/**
 * `action_pec_legal_archive` — NodeDef.
 *
 * @module actions/pec_legal_archive/definition
 */

import type { NodeDef } from '@flowforge/core-schema';

export const pecLegalArchiveNodeDef: NodeDef = {
  id: 'action_pec_legal_archive',
  type: 'action',
  label: 'PEC: Archiviazione a Norma',
  icon: 'archive',
  color: '#0ea5e9',
  description:
    'Archivia messaggi PEC (Posta Elettronica Certificata) in conformità alla normativa italiana sulla ' +
    'conservazione a norma di legge dei documenti informatici fiscali e amministrativi: DPR 445/2000 (testo unico ' +
    'documentazione amministrativa), DM 17/06/2014 (regole tecniche conservazione), AgID Linee Guida 2020 + ' +
    'aggiornamento 2024 (formato + metadati + impronta crittografica). Salva l\'eml raw sul volume persistente ' +
    'del tenant in modalità append-only con umask 0600 (lettura/scrittura solo per il processo runtime ' +
    'proprietario, nessun accesso ad altri utenti del container — defense-in-depth contro lateral movement). ' +
    'Calcola tre digest crittografici dell\'intero messaggio originale (SHA-256 minimum normativo, SHA-384 + ' +
    'SHA-512 per future-proof contro deprecation futura SHA-256 sopra 2030), li serializza in un sidecar JSON ' +
    'firmato. Registra timestamp ISO 8601 UTC certo (clock NTP del server) e durata conservazione configurabile ' +
    '(default 10 anni = 3650 giorni come da art. 2220 Codice Civile per documenti contabili, ma estendibile a 15 ' +
    'anni per atti societari o fatture immobiliari). Append a manifest.jsonl globale del tenant per audit di ' +
    'integrità e ricerca cronologica veloce O(1) senza listing fs. ArchiveId deterministico (SHA-256 di ' +
    'messageId + receivedAt ISO) → operazione idempotente: ricevere due volte la stessa PEC (es. retry IMAP ' +
    'dopo crash) produce lo stesso archiveId e NON duplica i file sul disco. ' +
    'Output: { archiveId, archivePath, hashes, manifestEntry, retentionExpiresAt, verifyHookUrl }. ' +
    'La ricevuta è verificabile crittograficamente in qualsiasi momento via hook action_pec_legal_archive_verify ' +
    'che ricalcola SHA dal file e confronta col manifest — utile per perizia legale o ispezione GdF. ' +
    'Per delegare la conservazione sostitutiva a un conservatore accreditato AgID (Aruba Doc, InfoCert, ' +
    'Namirial, Postel), concatenare un action_http verso la loro API REST passando archivePath + hash SHA-256 ' +
    'computati qui — il conservatore appone marca temporale eIDAS qualificata e firma TSL. ' +
    'Use case: studio commercialista archivia 200 PEC/giorno con conservazione 10 anni per contestazioni AdE, ' +
    'fattura ricevuta da fornitore B2B con conservazione 11 anni (5 + 6 prescrizione ordinaria), atti societari ' +
    'di una S.r.l. cliente con conservazione 15 anni, integrazione automatica con Aruba Doc per delega legale, ' +
    'forensic export di tutte le PEC ricevute in un mese per audit auditor esterno.',

  configFields: [
    {
      key: 'archiveDir',
      label: 'Directory archivio (path assoluto)',
      type: 'text',
      required: false,
      defaultValue: '/data/pec-archive',
      help: 'Path assoluto sul volume tenant. Default /data/pec-archive — ' +
        'stesso volume del DB SQLite, persistente attraverso il restart del ' +
        'container. NON usare /tmp (volatile). I file vengono creati con ' +
        'umask 0600 (solo il processo tenant può leggerli).',
    },
    {
      key: 'conservationDays',
      label: 'Giorni di conservazione',
      type: 'number',
      required: false,
      defaultValue: '3650',
      help: 'Default 3650 (10 anni) per documenti fiscali IT (DPR 600/73 ' +
        'art. 22). Per documenti civili 2922 (8 anni). Range minimo 365 ' +
        '(1 anno) — sotto è inutile. Il valore viene stampato sul ' +
        'conservationUntil in output per audit.',
    },
    {
      key: 'hashAlgorithm',
      label: 'Algoritmo hash',
      type: 'select',
      required: false,
      options: ['sha256', 'sha384', 'sha512'],
      defaultValue: 'sha256',
      help: 'Default sha256 (industry standard 2026). sha384/sha512 più ' +
        'lenti ma migliore margine criptografico — usali se la policy ' +
        'aziendale lo richiede.',
    },
    {
      key: 'writeSidecar',
      label: 'Scrivi sidecar .<alg>',
      type: 'boolean',
      required: false,
      defaultValue: 'true',
      help: 'Quando ON, ogni file .eml ha accanto un .sha256 con l\'hash ' +
        '+ il nome file (formato compatibile con shasum -c). Default ON. ' +
        'Disabilita solo se vuoi gestire l\'integrity con un altro tool.',
    },
    {
      key: 'rawField',
      label: 'Campo input con eml raw',
      type: 'text',
      required: false,
      defaultValue: 'raw',
      help: 'Default "raw". Cambia se l\'upstream usa "body", "source", "eml".',
    },
    {
      key: 'messageIdField',
      label: 'Campo input con messageId',
      type: 'text',
      required: false,
      defaultValue: 'messageId',
      help: 'Default "messageId" (header Message-ID RFC 2822). ' +
        'Cambia se l\'upstream lo chiama "id" o "uid".',
    },
    {
      key: 'receivedAtField',
      label: 'Campo input con receivedAt (ISO)',
      type: 'text',
      required: false,
      defaultValue: 'receivedAt',
      help: 'Default "receivedAt". Stringa ISO 8601 UTC. Concorre alla ' +
        'derivazione deterministica dell\'archiveId.',
    },
    {
      key: 'pecTypeField',
      label: 'Campo input con tipo PEC (opzionale)',
      type: 'text',
      required: false,
      defaultValue: 'pecType',
      help: 'Default "pecType". Quando presente (es. "acceptance", ' +
        '"delivery", "rejection", "message") viene salvato nel manifest ' +
        'JSONL per filtraggio audit.',
    },
  ],

  vendor: 'flowforge',
  version: '1.0.0',
  cost: {
    typicalLatencyMs: 15,
  },
};

/**
 * `action_contact_lookup` — NodeDef metadata.
 *
 * @module actions/contact_lookup/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const contactLookupNodeDef: NodeDef = {
  id: 'action_contact_lookup',
  type: 'action',
  label: 'Rubrica: cerca un contatto',
  icon: 'user-search',
  color: '#8b5cf6',
  description:
    'Cerca un indirizzo nella rubrica di Medea e dice se lo conosce, chi è e a quale azienda appartiene. ' +
    'È il nodo con cui si scrive «solo se il mittente è in rubrica»: un `logic_if` su `found` subito dopo, e ' +
    'il flusso si divide fra chi conosciamo e chi no. ' +
    'Fino al 2026-08-05 questa condizione non era esprimibile: il catalogo non aveva modo di consultare i ' +
    'contatti, e le richieste che la contenevano — «quando arriva una email da un mittente della rubrica» — ' +
    'producevano workflow che quella parte la ignoravano in silenzio, senza che niente lo segnalasse. ' +
    'Sola lettura: non crea, non modifica e non cancella contatti. Un workflow non può sporcare la rubrica. ' +
    'La rubrica è quella di Medea, popolata dal sync della posta e dalla scheda Persone: nessun servizio ' +
    'esterno, nessuna chiave, nessun dato che esce dal computer. ' +
    'Use case: filtrare i trigger email sui mittenti conosciuti, arricchire un messaggio col nome e ' +
    'l’azienda prima di passarlo a un LLM, distinguere clienti da fornitori per instradare un flusso, ' +
    'saltare le automazioni sugli sconosciuti.',

  configFields: [
    {
      key: 'email',
      label: 'Indirizzo da cercare',
      type: 'text',
      required: false,
      help:
        'L’indirizzo esatto, di solito preso dal messaggio appena arrivato: ' +
        '`{{$node.<id_del_trigger>.json.from}}`. Il confronto ignora maiuscole e minuscole. ' +
        'In alternativa usa la ricerca libera qui sotto.',
    },
    {
      key: 'query',
      label: 'Ricerca libera',
      type: 'text',
      required: false,
      help:
        'Cerca per nome, indirizzo o dominio: «rossi», «@acme.it». Usala quando non hai un indirizzo ' +
        'preciso. Se valorizzi anche il campo sopra, vince quello: è più specifico.',
    },
    {
      key: 'onlyClients',
      label: 'Solo clienti',
      type: 'boolean',
      required: false,
      defaultValue: 'false',
    },
    {
      key: 'onlySuppliers',
      label: 'Solo fornitori',
      type: 'boolean',
      required: false,
      defaultValue: 'false',
    },
    {
      key: 'requireFound',
      label: 'Fallisci se non lo trova',
      type: 'boolean',
      required: false,
      defaultValue: 'false',
      help:
        'Spento (consigliato) il nodo riesce sempre e mette `found: false`, così puoi ramificare con un ' +
        '`logic_if`. Acceso, uno sconosciuto ferma il workflow con un errore: serve quando proseguire ' +
        'senza il contatto non avrebbe senso.',
    },
    {
      key: 'limit',
      label: 'Quanti risultati al massimo',
      type: 'number',
      required: false,
      defaultValue: '10',
      help: 'Vale per la ricerca libera. Cercando un indirizzo esatto il risultato è al più uno.',
    },
  ],

  outputs: ['default'],
  outputContract: {
    notes: 'Non trovare nessuno NON e` un errore, a meno di non chiederlo esplicitamente: `found` resta falso e `contact` null. E` il campo su cui si scrive «solo se il mittente e` in rubrica», con un `logic_if` subito dopo.',
    fields: [
      { name: 'found', type: 'boolean', desc: 'Se ha trovato almeno un contatto. E` il campo su cui diramare.' },
      { name: 'contact', type: 'object|null', desc: 'Il primo risultato — con email, name, isClient, isSupplier, organization, messageCount, lastSeenAt. Null se non ha trovato nessuno.' },
      { name: 'contacts', type: 'array', desc: 'Tutti i risultati. Cercando un indirizzo esatto ne contiene al piu` uno.' },
      { name: 'count', type: 'number', desc: 'Quanti contatti ha trovato.' },
    ],
  },
  vendor: 'flowforge',
  version: '1.0.0',
};

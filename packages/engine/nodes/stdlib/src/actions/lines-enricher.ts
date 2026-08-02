/**
 * action_lines_enrich — arricchisce le righe estratte da un PDF/Excel
 * (es. output di agent_extractor) con una "sotto-descrizione" condizionata
 * a regole configurabili dall'utente.
 *
 * USE CASE: ordini fornitore con codici articolo generici (es. "27/" o
 * "RB206DBX-2400") che richiedono una descrizione extra sotto al codice
 * principale per essere significativi. Altre sotto-righe (note tipo
 * "A saldo Vs. ordine") vanno invece IGNORATE.
 *
 * Federico-grade UX: due liste di regole stringa nel pannello config,
 * help-text con esempi reali, niente codice JavaScript da scrivere.
 */
import type { NodeModule } from '../types.js';

export const linesEnrichNode: NodeModule = {
  def: {
    id: 'action_lines_enrich',
    type: 'action',
    label: 'Righe: Arricchisci sotto-descrizione',
    icon: 'list-tree',
    color: '#0ea5e9',
    description:
      'Arricchitore enterprise specializzato per righe ordine estratte da PDF fornitore, che gestisce il ' +
      'pattern semantico "descrizione su due righe" tipico dei documenti di fornitura B2B italiani: la prima ' +
      'riga contiene il codice articolo + descrizione principale ("ROT-COIL-220V Bobina elettrica"), la seconda ' +
      'riga sottostante porta dettagli tecnici specifici dell\'item ("Voltaggio 220V AC 50Hz, IP65, certificata ' +
      'CE") che NON appartengono ad una nuova riga ordine ma sono qualificazione del codice precedente. Senza ' +
      'questo arricchimento, il parsing PDF naïve crea N+1 righe (1 per codice + 1 per descrizione) confondendo ' +
      'il downstream ERP import. Il nodo applica le regole configurate per identificare quali codici beneficiano ' +
      'di sub-description e li fonde nella product_description del corretto record line, eliminando le righe ' +
      'descrizione spurious. ' +
      'Logica intelligente di matching: solo i codici che corrispondono ai pattern regex configurati ottengono ' +
      'enrichment (es. "^ROT-[A-Z]+-[0-9]+V$" per matchare codici della famiglia ROT-COIL-220V/ROT-VALVE-380V/ ' +
      'ROT-MOTOR-110V), gli altri restano invariati. Esclude esplicitamente note generiche commerciali tipo ' +
      '"A saldo Vs. ordine n.X", "Spese accessorie", "Pagamento a 60gg fine mese", "IVA esposta" — testi che ' +
      'non sono descrizioni di prodotto ma metadata fiscali/commerciali. ' +
      'Customization rich delle regole: il customer admin definisce N pattern di matching con relativa policy ' +
      'di merge (concatenazione con separator " - ", append parentesi "(...) ", overwrite condizionato se la ' +
      'sub-description è più informativa, skip per pattern blocklist note generiche). ' +
      'Output: stesse lines del input ma con product_description arricchita per export downstream + ' +
      'lines.removed[] che traccia le righe descrizione fuse + audit log delle merge applicate per debug. ' +
      'Use case business reali da clienti enterprise: arricchire righe ordine estratte da PDF fornitore prima ' +
      "dell'export ERP (es. Sage X3, TeamSystem Polyedro, Zucchetti Ad Hoc) per evitare cleanup manuale del " +
      'controller); integrare codici prodotto specifici per vertical industriale (es. attuatori/valvole industriali: bobine, voltage spec, ' +
      'IP rating per impiantistica), automazione automotive (codici OEM), elettromedicale (CND+ATC code); ' +
      'normalizzare descrizioni multi-riga di fornitori legacy in singolo campo searchable per data warehouse ' +
      'analytics (es. "fornitore X usa 2 righe descrizione, fornitore Y usa 3, fornitore Z usa 1 — normalizzo ' +
      'tutti a 1"); pre-processare ordini Excel ricevuti da clienti che mantengono ancora il "modello a due ' +
      'righe Excel" cartaceo migrato a digitale; harmonization di anagrafica prodotti tra subsidiary di gruppi ' +
      'multinazionali che ognuno ha format suo.',
    configFields: [
      {
        key: 'linesExpression',
        label: 'Righe sorgente',
        type: 'expression',
        required: false,
        placeholder: '{{$node.extract_of.json.lines}}',
        help: "Espressione che ritorna l'array lines[] da arricchire. Se vuoto, usa l'input del nodo precedente. Ogni riga DEVE avere almeno product_code, product_description (gli altri campi sono passthrough).",
      },
      {
        key: 'rawTextExpression',
        label: 'Testo PDF grezzo',
        type: 'expression',
        required: true,
        placeholder: '{{$node.pdf_extract.json.text}}',
        help: 'Espressione che ritorna il testo grezzo del PDF (output di pdf_extract). Serve per cercare le sotto-righe indentate sotto a ogni codice.',
      },
      {
        key: 'includeCodePatterns',
        label: 'Codici che RICHIEDONO sotto-descrizione (uno per riga)',
        type: 'text',
        required: false,
        defaultValue: '^\\d{1,2}\\/$\n-BOB$\n-7000$\n-3510$\n-1865$\n-24DC$\n-24AC$\n-2400$',
        help: 'Una regex per riga, applicata al product_code. Se il codice matcha UNA delle regex, la sotto-descrizione viene cercata e aggiunta a product_description.\n\nDefault inclusi (esempio industriale):\n• ^\\d{1,2}\\/$ — codici generici tipo "27/", "8/"\n• -BOB$ — bobine senza voltage specifico (es. "RB206DBX-BOB")\n• -7000$, -3510$, -1865$, -24DC$, -24AC$, -2400$ — varianti voltage/sigla\n\nAggiungi altri pattern del tuo dominio: es. "^OPZ-" per opzionali, "-CUSTOM$" per personalizzazioni.',
      },
      {
        key: 'excludePrefixes',
        label: 'Sotto-righe da IGNORARE (uno per riga)',
        type: 'text',
        required: false,
        defaultValue:
          'A saldo Vs. ordine\nIn acc. Vs. ordine\nVostro riferimento\nNostro riferimento',
        help: 'Prefissi case-insensitive: se la sotto-riga inizia con uno di questi, viene IGNORATA (non aggiunta a product_description). Tipico: note amministrative, riferimenti commerciali, marker di pagamento.',
      },
      {
        key: 'separator',
        label: 'Separatore tra descrizione e sotto-descrizione',
        type: 'text',
        required: false,
        defaultValue: ' — ',
        help: 'Stringa inserita tra descrizione e sotto-descrizione quando entrambe sono presenti. Default " — " (em dash). Altre opzioni: " · " (interpunct), "\\n" (newline, per wrap cella Excel), " | " (pipe).',
      },
    ],
    outputs: ['lines', 'enrichedCount'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

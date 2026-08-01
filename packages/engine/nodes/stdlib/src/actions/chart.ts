import type { NodeModule } from '../types.js';

/**
 * NodeDef per `action_generate_chart`. SOLO metadata UI — il rendering vive
 * nell'executor server-only `chartGenerateExecutor` (apps/flowforge-runtime/src/
 * executors/chart.ts), che NON viene incluso nel bundle browser dell'editor.
 *
 * NOMI CAMPI: devono matchare ESATTAMENTE i `config.X` letti dall'executor.
 */
export const chartGenerateNode: NodeModule = {
  def: {
    id: 'action_generate_chart',
    type: 'action',
    label: 'Grafico: Genera (SVG)',
    vendor: 'flowforge',
    version: '1.0.0',
    icon: 'bar-chart-3',
    color: '#8b5cf6',
    description:
      'Generatore di grafici SVG (line, bar, pie, area) da un array di dati — la primitiva per QUALSIASI workflow ' +
      'che deve VISUALIZZARE numeri: report email con andamento, dashboard inviate via mail, riepiloghi periodici, ' +
      'confronti storici. Rendering SVG PURO server-side (zero dipendenze native: niente canvas/chart.js/sharp, ' +
      'quindi nessun binario .node, bundle leggero, sandbox-safe) → output testuale embeddabile DIRETTAMENTE ' +
      'nell\'HTML di un\'email come data-URI base64 (tag <img> già pronto nel campo imgTag), senza passare per ' +
      'filesystem o CDN. ' +
      'Tutto configurabile dall\'editor visuale, con default sensati su ogni campo (a prova di errore): tipo di ' +
      'grafico (barre/linea/torta/area), array dati come espressione ({{$node.X.json.serie}}), nome del campo ' +
      'etichetta (asse X / fette torta) e del campo valore (asse Y), titolo, dimensioni in pixel, palette colori. ' +
      'Robustezza enterprise: dati vuoti o non-array → grafico placeholder "Nessun dato" invece di crash; valori ' +
      'non numerici/NaN → trattati come 0; valori negativi → scala con baseline a zero; etichette troppe → ' +
      'diradate per non sovrapporsi; ogni testo da dato utente è XSS-escaped (l\'SVG finisce in un\'email HTML, ' +
      'una label malevola NON può iniettare script). ' +
      'Output: { svg, dataUri, imgTag, width, height, pointCount, primary }. ' +
      'Use case: report SEO settimanale con grafico storico degli errori vs settimana scorsa (dati da db_query ' +
      'upstream → linea temporale nell\'email); riepilogo vendite mensile a torta per categoria prodotto allegato ' +
      'alla riunione; andamento ticket di supporto a barre per il management; trend di iscrizioni newsletter; ' +
      'monitoraggio prezzi competitor nel tempo; cruscotto KPI inviato ogni lunedì mattina; confronto performance ' +
      'campagne marketing; istogramma distribuzione punteggi feedback clienti.',
    configFields: [
      {
        key: 'chartType',
        label: 'Tipo di grafico',
        type: 'select',
        required: false,
        options: ['bar', 'line', 'area', 'pie'],
        defaultValue: 'bar',
        help: 'Barre (categorie), linea/area (andamento nel tempo), torta (composizione %).',
      },
      {
        key: 'dataJson',
        label: 'Dati (array)',
        type: 'expression',
        required: true,
        placeholder: '{{$node.db_query_1.json.rows}}',
        help: 'Espressione che risolve a un ARRAY: di oggetti [{label, value}], di numeri [10,20,30], o di coppie [["Lun",10],...]. Se vuoto, usa l\'input del nodo.',
      },
      {
        key: 'labelField',
        label: 'Campo etichetta',
        type: 'text',
        required: false,
        defaultValue: 'label',
        placeholder: 'label',
        help: 'Nome del campo da usare come etichetta (asse X / fetta). Default "label". Ignorato se i dati sono numeri grezzi.',
      },
      {
        key: 'valueField',
        label: 'Campo valore',
        type: 'text',
        required: false,
        defaultValue: 'value',
        placeholder: 'value',
        help: 'Nome del campo numerico da plottare. Default "value".',
      },
      {
        key: 'title',
        label: 'Titolo',
        type: 'text',
        required: false,
        placeholder: 'es. Errori SEO — ultime 8 settimane',
        help: 'Titolo mostrato in alto. Supporta {{espressioni}}.',
      },
      {
        key: 'width',
        label: 'Larghezza (px)',
        type: 'number',
        required: false,
        defaultValue: '800',
        help: 'Larghezza in pixel (100–4000). Default 800.',
      },
      {
        key: 'height',
        label: 'Altezza (px)',
        type: 'number',
        required: false,
        defaultValue: '400',
        help: 'Altezza in pixel (100–4000). Default 400.',
      },
      {
        key: 'palette',
        label: 'Palette colori',
        type: 'select',
        required: false,
        options: ['default', 'blues', 'greens', 'warm'],
        defaultValue: 'default',
        help: 'Schema colori del grafico.',
      },
      {
        key: 'outputFormat',
        label: 'Formato output principale',
        type: 'select',
        required: false,
        options: ['dataUri', 'svg'],
        defaultValue: 'dataUri',
        help: 'dataUri (base64, per <img> in email HTML) o svg (markup grezzo). Entrambi sono sempre disponibili nell\'output.',
      },
    ],
    outputs: ['svg', 'dataUri', 'imgTag', 'width', 'height', 'pointCount', 'primary'],
  },
};

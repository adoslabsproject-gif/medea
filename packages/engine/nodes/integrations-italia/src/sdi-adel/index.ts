import type { NodeModule } from '@medea/engine-nodes-stdlib';

/**
 * Sistema di Interscambio (SDI) / Agenzia delle Entrate — fattura elettronica.
 * Spec: https://www.fatturapa.gov.it/it/norme-e-regole/
 * Trasmissione via canale SDICoop SOAP, accreditamento richiesto.
 * Firma XADES-BES con certificato qualificato CADES-BES.
 *
 * IMPORTANTE: i nomi dei campi devono matchare ESATTAMENTE quelli letti
 * dall'executor `sdiSendInvoiceExecutor` in `apps/runtime/src/executors/italian.ts`.
 * Se rinomini qui, rinomina anche nell'executor o il nodo si rompe silenziosamente.
 */
export const sdiSendInvoice: NodeModule = {
  def: {
    id: 'italia_sdi_send_invoice',
    type: 'action',
    label: 'SDI: Send FatturaPA',
    icon: 'send',
    color: '#1e40af',
    description:
      'Trasmette una fattura elettronica FatturaPA (XML standard SDI v1.2.2) al Sistema di Interscambio Agenzia delle Entrate. ' +
      "Channel via PEC accreditato o SDIcoop/ADEL (canale diretto SOAP autenticato). Validazione XSD pre-invio contro lo schema UFFICIALE FatturaPA v1.2.2 dell'Agenzia delle Entrate (validateXsd, default ON, offline via libxml2): una fattura non conforme viene RIFIUTATA subito con gli errori XSD, prima di firmare e di consumare una chiamata al SdI (che la scarterebbe con notifica di scarto). Firma XAdES-BES enveloped opzionale (SHA-256 + RSA, cert+key PEM). " +
      'Output: { sdiId, status (sent/accepted/rejected), notificationFile, deliveryTimestamp }. ' +
      'Use case: invio automatico fatture B2B/B2G post-emissione Fatture in Cloud, ' +
      'invio massivo fine ciclo fatturazione, integrazione con ERP legacy via canale FlowForge.',
    configFields: [
      {
        key: 'invoiceXml',
        label: 'XML FatturaPA',
        type: 'code',
        language: 'json',
        required: true,
        placeholder:
          '<?xml version="1.0" encoding="UTF-8"?>\n<p:FatturaElettronica ...>...</p:FatturaElettronica>',
        help: 'XML completo formato P_IT_PA (PA), P_IT_B2B (aziende), P_IT_B2C (consumatori). Tipicamente generato a monte dal nodo "Fatture in Cloud: Create Invoice" o da uno script personalizzato.',
      },
      {
        key: 'sdiUsername',
        label: 'SDICoop username',
        type: 'text',
        required: true,
        placeholder: 'username accreditato',
        help: "Account dichiarato all'Agenzia delle Entrate sul canale SDICoop SOAP. Richiede accreditamento (procedura su fatturapa.gov.it).",
      },
      {
        key: 'sdiPassword',
        label: 'SDICoop password',
        type: 'secret',
        required: true,
      },
      {
        key: 'sdiUrl',
        label: 'Endpoint SDI',
        type: 'select',
        required: false,
        options: [
          'https://servizi.fatturapa.it/Services/SdIRiceviFile/RiceviFile',
          'https://testservizi.fatturapa.it/Services/SdIRiceviFile/RiceviFile',
        ],
        defaultValue: 'https://testservizi.fatturapa.it/Services/SdIRiceviFile/RiceviFile',
        help: 'URL SOAP del SDI. Default = TEST (testservizi.fatturapa.it). PARTI SEMPRE DAL TEST. Switcha al production solo dopo validazione end-to-end.',
      },
      {
        key: 'validateXsd',
        label: 'Valida XSD pre-invio (schema ufficiale FatturaPA v1.2.2)',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: "On (default) = valida la fattura contro lo schema XSD ufficiale dell'Agenzia PRIMA di inviarla: se non conforme, il nodo fallisce subito con gli errori, evitando lo scarto del SdI. Off = invia senza validare (solo se sai che l'XML è già conforme).",
      },
      {
        key: 'skipSigning',
        label: 'Salta firma (XML già firmato a monte)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: "Se on, FlowForge NON firma l'XML (usa quello che gli passi as-is). Utile quando hai un software del commercialista che firma e tu inoltri solo. Se off, FlowForge firma con cert+key qui sotto.",
      },
      {
        key: 'certPem',
        label: 'Certificato firma (PEM inline)',
        type: 'secret',
        required: false,
        help: 'Certificato qualificato CADES-BES in formato PEM (-----BEGIN CERTIFICATE-----). Necessario se skipSigning=off. In alternativa imposta MEDEA_SDI_CERT_PATH sul server e lascia vuoto qui.',
        showIf: { field: 'skipSigning', truthy: false },
      },
      {
        key: 'keyPem',
        label: 'Chiave privata firma (PEM inline)',
        type: 'secret',
        required: false,
        help: 'Chiave privata del certificato in formato PEM (-----BEGIN PRIVATE KEY-----). NON condividere. In alternativa imposta MEDEA_SDI_KEY_PATH sul server.',
        showIf: { field: 'skipSigning', truthy: false },
      },
      {
        key: 'certPath',
        label: 'Path certificato su disco (alternativa a PEM inline)',
        type: 'file-picker',
        required: false,
        help: 'Path file .pem del certificato dentro la sandbox del tenant. Usato solo se certPem (sopra) è vuoto. Per server-managed certs usa la env MEDEA_SDI_CERT_PATH invece.',
        showIf: { field: 'skipSigning', truthy: false },
      },
      {
        key: 'keyPath',
        label: 'Path chiave privata su disco',
        type: 'file-picker',
        required: false,
        help: 'Path file .pem della chiave privata. Stessa logica di certPath.',
        showIf: { field: 'skipSigning', truthy: false },
      },
      {
        key: 'fileName',
        label: 'Nome file da inviare (opzionale)',
        type: 'expression',
        required: false,
        placeholder: 'IT12345678901_{{loop.index + 1}}.xml',
        help: 'Naming standard SDI: IT<P.IVA>_<progressivo>.xml (5 cifre). Tipicamente dinamico — usa espressioni come {{loop.index}} per il progressivo. Se vuoto, FlowForge genera "IT<timestamp>_FF.xml".',
      },
    ],
    outputContract: {
      notes: '`identificativoSdi` e` il numero con cui si controllera` lo stato piu` avanti, con `italia_sdi_check_status`: senza quello la fattura non si puo` seguire. L\'invio riuscito NON significa fattura accettata — lo Sdi risponde dopo.',
      fields: [
        { name: 'fileName', type: 'string', desc: 'Il nome del file trasmesso.' },
        { name: 'identificativoSdi', type: 'string|null', desc: 'Il numero assegnato dallo Sdi: serve per controllare lo stato piu` avanti.' },
        { name: 'dataOraRicezione', type: 'string|null', desc: 'Quando lo Sdi l\'ha ricevuta.' },
        { name: 'signedXml', type: 'string|null', desc: 'L\'XML firmato, troncato. Null se la firma era disattivata.' },
        { name: 'rawResponse', type: 'string', desc: 'La risposta grezza dello Sdi, troncata.' },
      ],
    },
    vendor: 'flowforge-italia',
    version: '0.3.0',
  },
};

export const sdiCheckStatus: NodeModule = {
  def: {
    id: 'italia_sdi_check_status',
    type: 'action',
    label: 'SDI: Check Invoice Status',
    icon: 'search',
    color: '#1e40af',
    description:
      'Recupera lo stato di una fattura inviata al SDI (RC = ricevuta committente, NS = notifica scarto, MC = mancata consegna, NE = notifica esito, DT = decorrenza termini).',
    configFields: [
      {
        key: 'fileName',
        label: 'Nome file FatturaPA inviata',
        type: 'text',
        required: true,
        placeholder: 'es. IT12345678901_0001.xml.p7m',
        help: "Stesso nome usato all'invio (ITxxxxxxxxxxx_NNNNN.xml o .xml.p7m).",
      },
      {
        key: 'sdiUsername',
        label: 'SDICoop username',
        type: 'text',
        required: true,
      },
      {
        key: 'sdiPassword',
        label: 'SDICoop password',
        type: 'secret',
        required: true,
      },
    ],
    outputContract: {
      notes: '`status` a \'unknown\' significa che la risposta non conteneva uno stato riconoscibile — non che la fattura sia in ordine.',
      fields: [
        { name: 'fileName', type: 'string', desc: 'Il file di cui e` stato chiesto lo stato.' },
        { name: 'status', type: 'string', desc: 'Lo stato dichiarato dallo Sdi. \'unknown\' se non e` stato riconosciuto.' },
        { name: 'rawResponse', type: 'string', desc: 'La risposta grezza dello Sdi, troncata.' },
      ],
    },
    vendor: 'flowforge-italia',
    version: '0.2.0',
  },
};

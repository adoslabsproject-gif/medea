/**
 * agent_legal_compliance — compliance analysis IT/EU.
 *
 * Analizza un documento (contratto, privacy policy, ToS, DPA, cookie banner)
 * contro normative IT/EU:
 *   - GDPR (Reg. UE 2016/679) — basi giuridiche, art.13/14 informativa, DPIA art.35, DPO art.37, trasferimenti extra-UE
 *   - eIDAS 2.0 (Reg. UE 910/2014 + amendments 2024) — firme elettroniche, sigilli, timestamp qualificati
 *   - AI Act (Reg. UE 2024/1689) — classificazione rischio, trasparenza, conformità foundation models
 *   - DPR 445/2000 — conservazione documentale a norma
 *   - Codice Consumo (D.lgs. 206/2005) — clausole vessatorie, recesso, garanzia
 *   - e-Privacy 2002/58/EC — cookie/marketing consensi
 *
 * Pipeline:
 *  1. Document chunking (semantic, max 2k token per chunk)
 *  2. KB retrieval (ai_rag_search su corpus normative pre-indicizzato)
 *  3. Liara LLM analysis per chunk con tool searchKnowledge
 *  4. Fusion findings → severity + reference articolo + remediation
 *
 * Output: { score 0-100, findings[], frameworks[], recommendations[], summary }
 */
import type { NodeModule } from '../types.js';

export const legalComplianceNode: NodeModule = {
  def: {
    id: 'agent_legal_compliance',
    type: 'action',
    label: 'Legal Compliance (GDPR + eIDAS + AI Act)',
    icon: 'scale',
    color: '#0ea5e9',
    description:
      'Agente AI enterprise specializzato in compliance legale di documenti italiani ed europei — analizza ' +
      'contratti, privacy policy, Terms of Service (ToS), Data Processing Agreement (DPA), cookie banner, ' +
      'normative interne aziendali, verificando la conformità contro la batteria completa dei principali ' +
      'framework normativi che si applicano al business digitale italiano nel 2025-2026: GDPR (Regolamento UE ' +
      '2016/679 sul trattamento dati personali), eIDAS 2.0 (Regolamento UE 910/2014 + aggiornamento 2024 ' +
      'sulla identità digitale europea + firma elettronica qualificata), AI Act (Regolamento UE 2024/1689 ' +
      'in vigore agosto 2024 sulla classificazione dei sistemi AI in 4 livelli rischio + obblighi per ' +
      'fornitori e utilizzatori), DPR 445/2000 (testo unico documentazione amministrativa per archiviazione ' +
      'a norma), Codice del Consumo (D.lgs. 206/2005 con tutti i diritti del consumatore B2C), Direttiva ' +
      'e-Privacy 2002/58/EC (regola tracciamento cookie e marketing communications). ' +
      'Pipeline AI multi-stage che combina retrieval e generation per garantire ANTI-HALLUCINATION rigorosa ' +
      '— pattern critical per use case legali dove un erroneo cite di articolo non esistente sarebbe ' +
      'professionalmente damaging: (1) chunking semantico del documento input in segment manageable dal LLM ' +
      'context window, preservando i confini logici di paragrafi/sezioni; (2) ai_rag_search su una KB ' +
      'normative pre-indicizzata via embedding BGE-M3 1024-dim dei testi ufficiali AgID/EUR-Lex con i 1500+ ' +
      'articoli rilevanti dei 6 framework supportati; (3) Liara LLM analizza ogni chunk con il context ' +
      "normativo retrieved e produce findings strutturati con CITAZIONE ESPLICITA dell'articolo violato + " +
      'reasoning step-by-step; (4) fusion finale dei findings con severity ranking (critical → high → ' +
      'medium → low → info) e dedup di issue duplicate. ' +
      'Output rich strutturato per consumo umano + machine: { score (0-100 normalizzato di compliance, < 50 ' +
      'critical, 50-70 da migliorare, 70-90 buono, > 90 eccellente), findings: [{ severity, framework (es. ' +
      '"GDPR"), articleNumber (es. "art. 5(1)(c)"), description (cosa è il problema in italiano leggibile), ' +
      'evidenceQuote (la frase originale del documento che ha triggered il finding), remediation (azione ' +
      'concrete per fix), confidence }], frameworksAnalyzed, summary (executive summary 200-400 char), ' +
      'recommendations (top 5 azioni prioritizzate by impact), analyzedAt, modelVersion }. ' +
      'Use case enterprise critical italiani: pre-firma contratto B2B per red flag clausole vessatorie e ' +
      'derogatorie dello consumer code (pattern delle clausole limitanti di responsabilità del fornitore ' +
      'verso il cliente B2B finance/services); audit privacy policy sito web pre-pubblicazione (verifica ' +
      'GDPR art.13 informativa completa + ePrivacy cookie banner + eIDAS link identità del titolare); ' +
      'DPIA (Data Protection Impact Assessment) art.35 GDPR per nuovo trattamento dati sensibili (richiesto ' +
      'before-launch di feature che processa dati sanitari o biometrici); compliance gate pre-launch di ' +
      'feature AI-powered con classifica rischio AI Act (es. "il nostro sistema di selezione candidati ' +
      'rientra in high-risk Annex III del AI Act → obblighi di documentazione tecnica + audit periodico"); ' +
      'review cookie banner per consenso valido art.7 GDPR + Linee Guida Garante 2024 (no pre-ticked checkbox, ' +
      'opt-in granular per category, dark pattern detection).',
    configFields: [
      {
        key: 'documentText',
        label: 'Testo documento',
        type: 'expression',
        required: true,
        placeholder: '{{input.contractText}} o {{$node.PdfParse.output.text}}',
        help: 'Testo del documento da analizzare. Min 200 char, max 200KB. Per PDF usa action_pdf_parse upstream.',
      },
      {
        key: 'frameworks',
        label: 'Framework da verificare',
        type: 'select',
        required: false,
        defaultValue: 'gdpr,eidas,ai_act',
        options: [
          'gdpr',
          'gdpr,eidas',
          'gdpr,eidas,ai_act',
          'gdpr,eidas,ai_act,dpr445,consumer,eprivacy',
        ],
        help: 'CSV framework. Più framework = analisi più lunga ma più completa.',
      },
      {
        key: 'documentType',
        label: 'Tipo documento (hint)',
        type: 'select',
        required: false,
        defaultValue: 'auto',
        options: [
          'auto',
          'privacy_policy',
          'terms_of_service',
          'dpa',
          'contract_b2b',
          'contract_b2c',
          'cookie_banner',
          'dpia',
          'other',
        ],
        help: 'Type hint per prompt specializzato. "auto" detect dal contenuto via LLM.',
      },
      {
        key: 'jurisdiction',
        label: 'Giurisdizione',
        type: 'select',
        required: false,
        defaultValue: 'it_eu',
        options: ['it_eu', 'eu', 'it'],
        help: 'it_eu = Italia + EU (default), eu = solo EU, it = solo Italia (D.lgs. nazionali).',
      },
      {
        key: 'severityFloor',
        label: 'Severity minima',
        type: 'select',
        required: false,
        defaultValue: 'medium',
        options: ['critical', 'high', 'medium', 'low'],
        help: 'Soglia minima findings nel report. medium = ignora "low" notes pedanti.',
      },
      {
        key: 'useExternalKb',
        label: 'Usa KB esterno legal_kb_it_eu (avanzato)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Default OFF: il nodo usa compendio normative inline (out-of-the-box, zero setup). ON: abilita tool searchKnowledge su collection legal_kb_it_eu — richiede popolazione manuale del KB con full-text articoli/giurisprudenza.',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

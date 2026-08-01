import type { NodeModule } from '@flowforge/nodes-stdlib';


/**
 * Zucchetti HR Go / HRMS — payroll + employee management.
 * API: REST, token-based, endpoint varia per cliente (negoziato in fase di contratto).
 */
export const zucchettiPayroll: NodeModule = {
  def: {
    id: 'italia_zucchetti_payroll',
    type: 'action',
    label: 'Zucchetti: Payroll Trigger',
    icon: 'wallet',
    color: '#dc2626',
    description:
      'Avvia un job di elaborazione cedolini su Zucchetti HR Go (payroll API REST, auth Bearer token API). ' +
      'Input: periodo (YYYY-MM), codice azienda, modalità simulazione/commit (dryRun). ' +
      'Output: la risposta JSON di HR Go passata AS-IS (tipicamente { jobId, status, estimatedMinutes, employeeCount } — la shape esatta dipende dalla tua istanza, il nodo non la normalizza). Polling status via secondo nodo recommended (job async). ' +
      'Use case: chiusura mensile payroll automatica (cron giorno 28), preview cedolini per HR review, ' +
      'on-demand recalculation post-correzione, batch cedolini multi-società per gruppi.',
    configFields: [
      { key: 'baseUrl', label: 'Base URL HR Go', type: 'text', required: true, placeholder: 'https://hrgo.azienda.it/api', help: 'URL dell\'istanza HR Go della tua azienda (endpoint negoziato col contratto Zucchetti).' },
      { key: 'apiToken', label: 'API token', type: 'secret', required: true, help: 'Token API fornito da Zucchetti. Richiesto in fase di onboarding.' },
      { key: 'companyCode', label: 'Codice azienda', type: 'text', required: true, placeholder: 'es. AZ001', help: 'Codice identificativo dell\'azienda nel sistema Zucchetti (multi-tenant).' },
      { key: 'period', label: 'Periodo elaborazione', type: 'expression', required: true, placeholder: '{{$today.slice(0,7)}}', help: 'Mese di cedolino in formato YYYY-MM. Es. "2026-05". Dinamico via espressione: {{$today.slice(0,7)}} = mese corrente, oppure {{input.period}} dal nodo precedente.' },
      { key: 'dryRun', label: 'Solo simulazione (no commit)', type: 'boolean', required: false, defaultValue: 'true', help: 'On = simula l\'elaborazione senza salvare. SEMPRE on al primo test.' },
    ],
    vendor: 'flowforge-italia',
    version: '0.1.0',
  },
};

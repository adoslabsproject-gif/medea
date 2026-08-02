import type { NodeModule } from '../types.js';

export const cronTriggerNode: NodeModule = {
  def: {
    id: 'trigger_cron',
    type: 'trigger',
    label: 'Schedule (Cron)',
    icon: 'clock',
    color: '#22c55e',
    description:
      "Scheduler enterprise per esecuzione pianificata di workflow su base cron — l'innesco di tutte le " +
      'pipeline di automation ricorrente tempo-based che dominano i workflow business (reporting giornaliero, ' +
      'cleanup notturno, sync periodici, email settimanali, alerting orario). Implementa il modello cron Unix ' +
      'classico (sintassi posizionale "min hour day month dow") esteso con builder visuale no-code per ' +
      'non-developer commercialisti/marketer che vogliono "ogni lunedì alle 09:00" senza dover ricordare la ' +
      'sintassi `0 9 * * 1`. ' +
      'Builder UI con tre modalità complementari: frequenza preset (ogni N minuti/ore/giorni/settimane con ' +
      'spinner numerico — pattern "ogni 15 minuti", "ogni 6 ore", "ogni 3 giorni"), regolazione fine ' +
      '(combinator visuale di minute+hour+day_of_week+day_of_month+month con dropdown selettivi), expressione ' +
      'cron string libera per power user che conoscono la sintassi ("0 9 1-15 * *" = "ore 9:00 dei giorni 1-15 ' +
      'di ogni mese"). Anteprima umana sempre visibile sotto il widget ("Ogni lunedì alle 09:00 UTC", "Il 1 ' +
      'di ogni mese alle 03:00 Europe/Rome") per confidence-check dell\'utente prima del save. ' +
      'Timezone-aware: default UTC ma il tenant può configurare timezone preferita (Europe/Rome standard per ' +
      'business italiano) — il cron è valutato secondo quella timezone, gestendo correttamente DST transition ' +
      '(ora legale/ora solare 2x l\'anno) per evitare il classico bug "il report delle 09:00 oggi è arrivato ' +
      'alle 10:00 perché è cambiata l\'ora legale". ' +
      'Architettura distribuita: lo scheduler vive nel portal centrale (non nel container tenant) — questo ' +
      'significa che cron continuano a partire anche con container in pausa (lifecycle sweeper sospende i ' +
      "container idle), e il portal fa wake-up automatico del container quando arriva l'ora di execution (no " +
      'sleep penalty su piano Free). Il portal mantiene il last_fired_at di ogni cron e gestisce ' +
      'missed_runs detection (se il container era down per > 1 schedule, il portal sa quanti runs sono stati ' +
      'persi e può decidere catch-up o skip in base a policy configurable). ' +
      "Input al workflow downstream: { triggeredAt (ISO timestamp del firing), scheduledFor (l'orario nominale " +
      'configurato — può differire da triggeredAt per pochi secondi su scheduler delay), missedRuns? (count se ' +
      'sono stati saltati run precedenti), timezone, cronExpression }. ' +
      'Use case: report giornaliero KPI mattina inviato al CEO via email/Telegram con summary del business ' +
      'precedente (cron "0 8 * * 1-5" = ore 8 dei giorni feriali); polling cron orario su API third-party che ' +
      'non hanno webhook (controllo nuovi ordini su marketplace, cambi di tasso di cambio per pricing dinamico, ' +
      'updates da gestionale legacy); cleanup periodico DB del tenant per rimozione record obsoleti GDPR ' +
      'compliance (cron daily 03:00); sync nightly CRM bidirezionale tra Pipedrive e Salesforce/HubSpot per ' +
      'multi-CRM strategy; email summary settimanale del team performance ogni domenica sera per i manager.',
    configFields: [
      {
        key: 'cronExpression',
        label: 'Pianificazione',
        type: 'cron-builder',
        required: true,
        defaultValue: '0 9 * * 1-5',
        help: 'Wizard frequenza + anteprima umana. Switcha "Cron personalizzato" per editare i 5 campi a mano.',
      },
      {
        key: 'timezone',
        label: 'Fuso orario',
        type: 'timezone-picker',
        required: false,
        defaultValue: 'Europe/Rome',
        help: 'Fuso orario IANA. La pianificazione è valutata in questo fuso (es. "alle 9:00 in Europe/Rome").',
      },
    ],
    vendor: 'flowforge',
    version: '1.1.0',
  },
};

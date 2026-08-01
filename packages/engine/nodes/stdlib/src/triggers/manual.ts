import type { NodeModule } from '../types.js';

export const manualTriggerNode: NodeModule = {
  def: {
    id: 'trigger_manual',
    type: 'trigger',
    label: 'Manual',
    icon: 'play',
    color: '#22c55e',
    description:
      'Innesco manuale enterprise pensato per il ciclo developer/operatore di sviluppo, debug, validazione di ' +
      'un workflow prima della messa in produzione automatica — l\'equivalent del bottone "Run" di n8n, ' +
      '"Test pipeline" di Make/Integromat, o "Execute SQL" di un editor database. Il workflow resta in stato ' +
      'idle (nessun consumo di risorse) finché l\'utente non clicca esplicitamente il bottone "Esegui" del Topbar ' +
      'dell\'editor FlowForge (oppure equivalente shortcut da tastiera Ctrl+Enter / Cmd+Enter). Una volta avviato, ' +
      'il run procede come qualsiasi altro: stessi nodi esecutori reali, scrive su SQLite runs/steps come al ' +
      'solito (NO modalità sandbox o dry-run separata — il side effect REAL), audit_log tracciato come ' +
      'trigger_type=\'manual\' nell\'analytics dashboard del tenant per separazione dei run manuali (test, ' +
      'one-shot operativi) dai run automatici (produzione). ' +
      'Input al workflow downstream: il caller può passare un payload JSON arbitrario tramite il modal di test ' +
      'dell\'editor (form rich con autocomplete dai run history precedenti — pattern velocità del developer ' +
      'che vuole rieseguire test con varianti minime), oppure semplicemente lanciare con input vuoto se il ' +
      'workflow non richiede dati di ingresso. Il triggeredBy del run viene popolato con lo user_id loggato — ' +
      'utile per audit "chi ha lanciato manualmente questa pipeline" in caso di incident review. ' +
      'NO trigger automatico: questo nodo non parte mai da solo, niente cron interno, niente webhook listener, ' +
      'niente file watch — è strettamente reactive a click utente. Per workflow di produzione che devono partire ' +
      'automatically usa trigger_cron (schedulato a tempi fissi), trigger_webhook (POST esterno), ' +
      'trigger_imap (email ricezione), trigger_form (web form embed), trigger_file_watch (filesystem drop), ' +
      'trigger_db_change (mutation database), trigger_rss_feed (feed update), trigger_odoo_polling (ERP). ' +
      'Use case: testing rapido durante editing iterativo (modifica config → click Esegui → verifica output → ' +
      'aggiusta → click Esegui → ...); dry-run con input mock prima di propagare in produzione il workflow ' +
      'reale (es. testare email_send con destinatario "test@me.com" prima di puntare alla lista cliente di 500 ' +
      'persone); esecuzione one-shot di workflow scheduled (es. il workflow di chiusura conti mensile è ' +
      'normalmente cron 1° del mese 03:00, ma il commercialista vuole rilanciarlo oggi pomeriggio dopo aver ' +
      'corretto un dato nei conti — click Esegui invece di aspettare il prossimo cron tick); execution su ' +
      'demand di workflow di reporting custom per produrre l\'export richiesto al volo dal CEO; debug ' +
      'interactive di workflow falliti con replay manuale step-by-step.',
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

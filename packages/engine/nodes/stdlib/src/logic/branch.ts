import type { NodeModule } from '../types.js';

/**
 * IF / Condition node v2.0 — Federico-grade.
 *
 * v1.0 had only a single free-text expression field. v2.0 adds:
 *   • Visual condition builder (`condition-rules`): multi-rule editor with
 *     left operand + operator + right value + per-type operators (string
 *     contains/regex/starts-with, number gt/lt/between, date before/after,
 *     exists/not-exists, boolean is-true/is-false).
 *   • AND / OR combinator across rules.
 *   • Case sensitivity toggle per rule.
 *   • Falls back to the legacy `condition` expression if rules aren't set
 *     (full back-compat).
 */
export const ifNode: NodeModule = {
  def: {
    id: 'logic_if',
    type: 'logic',
    label: 'If / Condition',
    icon: 'git-branch',
    color: '#f59e0b',
    description:
      'Operatore di branching binario condizionale enterprise — il control flow primitive di qualsiasi ' +
      'pipeline che ha bisogno di prendere una decisione "questo va a sinistra, quest\'altro a destra" e che ' +
      "corrisponde concettualmente all'if-else dei linguaggi di programmazione classici. Valuta una " +
      'condizione e instrada il workflow lungo il ramo "true" (yes) oppure il ramo "false" (no) — l\'engine ' +
      'FlowForge esegue SOLO il ramo scelto (vedere chosenBranch + workflow-engine strategy logic-if), evitando ' +
      'fan-out su entrambi e sprecando risorse + side effects indesiderati. ' +
      'Due modalità di definizione della condizione mutuamente esclusive per coprire spettro complete dei case: ' +
      "(1) Builder visuale multi-regola — l'interfaccia no-code per non-developer commercialisti/marketing/" +
      'amministrativi: aggiungi una o più regole composabili con combinatori AND/OR (logical operator scelto ' +
      'top-level), ogni regola consiste di un field path (dot-notation come "$node.triage.json.label"), un ' +
      'operatore type-aware (per stringhe: equals, not_equals, contains, starts_with, ends_with, matches_regex, ' +
      'is_empty; per numeri: greater_than, less_than, between, greater_than_or_equal; per array/collezioni: ' +
      'in, not_in, contains_any, contains_all, size_equals; per booleani: is_true, is_false; universal: ' +
      'exists, not_exists per null/undefined check), e un valore di confronto (può essere literal o ' +
      'expression {{$node.config.threshold}} valutata runtime); ' +
      "(2) Espressione JavaScript libera — back-compat con l'engine v1 e fallback per condizioni veramente " +
      'complesse non esprimibili nel builder (es. "input.amount > input.user.tier_limit && Date.parse(input.due) ' +
      '< Date.now()") — valutata dall\'interprete sicuro del runtime (denylist anti-escape + scope curato + ' +
      "timeout 250ms; il confine forte è l'isolamento per-tenant in container Docker), con accesso a $node, " +
      '$input, $vars + helper tipo $date, $string e le pipe (| upper, | round, | currency, …). ' +
      'Use case canonici: routing email triagata (è un ordine cliente? → ramo Salesforce updateOrder, altrimenti ' +
      '→ ramo notifications agli operatori); gate su soglia di confidence di un classifier ML (confidence > 0.8 ' +
      '→ ramo auto-processed, altrimenti → ramo human_review); permission check pre-action (user.role === ' +
      "'admin' → ramo dangerous_action allowed, altrimenti → ramo deny + audit log); A/B routing " +
      "utenti su feature flag (user.experiment_cohort === 'B' → ramo new_experience, altrimenti → ramo " +
      'control); validazione amount per workflow finanziari (amount > 10000 → ramo approval_workflow CFO, ' +
      'altrimenti → ramo auto_approve immediato).',
    configFields: [
      {
        key: 'conditionRules',
        label: 'Condizioni (visual builder)',
        type: 'condition-rules',
        required: false,
        help:
          'Builder visuale: aggiungi regole con operando di sinistra, operatore, valore di destra. ' +
          'AND/OR fra le regole. Operatori per tipo: stringa (contains/regex/...), numero (gt/lt/between), ' +
          'data (before/after), boolean (is-true/is-false), generico (exists). ' +
          'Se vuoto, viene usata l\'espressione "Condizione (espressione libera)" qui sotto.',
      },
      {
        key: 'condition',
        label: 'Condizione (espressione libera)',
        type: 'expression',
        required: false,
        placeholder: 'input.status === "active"',
        help:
          'Usata SOLO se il builder visuale qui sopra è vuoto. ' +
          'Espressione JS che ritorna true/false. Variabili: input, output, ctx, vars.',
      },
    ],
    outputs: ['true', 'false'],
    branching: true,
    outputContract: {
      notes: 'Il nodo NON lascia passare i dati che riceve: a valle arrivano questi tre campi. Chi sta dopo un `logic_if` e vuole il messaggio originale deve leggerlo dal nodo che l\'ha prodotto, non da qui.',
      fields: [
        { name: 'branch', type: 'string', desc: 'Il ramo imboccato: \'true\' oppure \'false\'.' },
        { name: 'condition', type: 'string', desc: 'La condizione come e` stata valutata, in forma leggibile: serve a capire perche` ha scelto quel ramo.' },
        { name: 'truthy', type: 'boolean', desc: 'L\'esito della condizione.' },
      ],
    },
    vendor: 'flowforge',
    version: '2.1.0',
  },
};

/**
 * Switch node v2.0 — adds a default/fallback output and per-case rule mode.
 *
 * v1.0 just matched the expression value against each case's literal. v2.0
 * keeps that as the simple path, AND adds:
 *   • An explicit fallback branch when no case matches.
 *   • The option to use `condition-rules` per case (set in the case row
 *     via the rulesJson sidecar; legacy literal matching stays the default).
 */
export const switchNode: NodeModule = {
  def: {
    id: 'logic_switch',
    type: 'logic',
    label: 'Switch',
    icon: 'git-fork',
    color: '#f59e0b',
    description:
      "Operatore di branching N-way enterprise — l'equivalent del switch/case dei linguaggi di programmazione " +
      'classici (Java, C#, JavaScript, Python match) applicato al workflow orchestration. Mentre logic_if ' +
      'è binario (true/false), logic_switch instrada il flusso su uno tra molti rami in base al valore di ' +
      "un'espressione discriminante — pattern fondamentale per routing a dispatcher basato su tipo di " +
      'evento, categoria, status, regione, customer tier, e centinaia di altri campi categorical che ' +
      'richiedono "se è A vai qui, se è B vai là, se è C ancora altrove, altrimenti gestisci come default". ' +
      'Ogni "case" è una porta di output dedicata del nodo nel grafo del workflow editor, etichettata con il ' +
      'valore matched (es. "order_confirmed", "refund_requested", "subscription_cancelled") — l\'utente collega ' +
      "visualmente ogni porta a una catena di azioni diversa, e l'engine FlowForge esegue SOLO il ramo scelto " +
      'in base alla chosenBranch decision (vedere workflow-engine strategy logic-switch) evitando fan-out su ' +
      'tutti i rami e sprecando risorse + side effects indesiderati. ' +
      'Modalità di matching per case: ' +
      '(1) Literal match (default) — comparison esatto value === case_value (con type coercion intelligente: ' +
      '"42" matcha 42 number, "true" matcha boolean true) — il pattern più semplice e più comune che copre ' +
      '90% degli use case enum-like; ' +
      '(2) Condition-rules sidecar — per case con logica complessa che NON è esprimibile come singolo literal ' +
      "(es. \"matcha questo case se amount > 1000 AND country in ['IT', 'ES']\"), ogni case può avere un " +
      'condition-rules array opzionale che fa override del literal match con AND/OR builder visuale identico ' +
      'a logic_if — pattern hybrid per ottenere il visual N-way switch con la potenza condizionale del if. ' +
      'Ramo di fallback "default" obbligatorio attivabile: quando nessun case matcha, il flusso prosegue ' +
      'sull\'output "default" — pattern safety per non lasciare workflow stuck su input inatteso (es. nuovo ' +
      'tipo di evento aggiunto upstream che il nostro switch non conosce ancora — vogliamo gestirlo gracefully ' +
      'con log + escalation invece di crash silenzioso). Il flag strictMode può rendere obbligatorio match ' +
      '(throw error se nessun case + no default) — pattern per workflow critici dove un fallthrough è bug. ' +
      'Use case: routing per tipo evento webhook (Stripe webhook può avere 50+ type — order.created → ramo ' +
      'fulfillment, charge.refunded → ramo customer success, subscription.deleted → ramo retention, ecc.); ' +
      'classificazione status di un ordine (pending → ramo "in attesa pagamento email cliente", paid → ramo ' +
      '"trigger fulfillment", failed → ramo "alert ops e retry pagamento", refunded → ramo "audit + recupero ' +
      'merce"); multi-tenant routing per workflow super-admin che processa eventi da N tenant diversi e li ' +
      'instrada al subprocess giusto del tenant target; routing per language (it → email italiano, en → ' +
      'inglese, de → tedesco, ecc. per workflow internazionali); dispatching per region geografica con SLA ' +
      'differenziati per cluster di server (EU → ramo Frankfurt, US → ramo Virginia, APAC → ramo Singapore).',
    configFields: [
      {
        key: 'expression',
        label: 'Espressione da confrontare',
        type: 'expression',
        required: true,
        placeholder: 'input.country',
        help: 'Espressione che produce il valore da matchare contro i casi sotto.',
      },
      {
        key: 'cases',
        label: 'Casi',
        type: 'switch-cases',
        required: true,
        help: 'Una riga per caso: valore → nome del ramo. Il primo match vince. Il ramo viene emesso come output.',
      },
      {
        key: 'fallbackBranch',
        label: 'Ramo di fallback',
        type: 'text',
        required: false,
        placeholder: 'default',
        defaultValue: 'default',
        help:
          'Nome del ramo emesso se nessun caso matcha. Lascia vuoto per emettere "default". ' +
          'Crea il corrispondente edge nel canvas con label uguale a questo valore.',
      },
      {
        key: 'caseSensitive',
        label: 'Match case-sensitive',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Se off: "Foo" matcha "foo". Utile per match su stringhe utente con case incoerente.',
      },
      {
        key: 'strictMode',
        label: 'Strict mode (errore se nessun match)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se ON: quando nessun caso corrisponde, il nodo SOLLEVA un errore invece di instradare al ramo di fallback. Per workflow critici dove un input non gestito è un bug, non un caso "default".',
      },
    ],
    outputs: ['*'],
    branching: true,
    outputContract: {
      notes: 'Come il `logic_if`, non lascia passare i dati in ingresso. `matchedCase` c\'e` SOLO quando un caso ha corrisposto: sul ramo di riserva non esiste.',
      fields: [
        { name: 'subject', type: 'string|null', desc: 'Il valore su cui ha deciso. Null se non si e` potuto leggere.' },
        { name: 'chosenBranch', type: 'string', desc: 'Il ramo imboccato: il nome del caso corrispondente, oppure il ramo di riserva (\'default\' se non configurato).' },
        { name: 'matched', type: 'boolean', desc: 'Vero se un caso ha corrisposto; falso se e` finito sulla riserva.' },
        { name: 'matchedCase', type: 'string', desc: 'Il valore del caso che ha corrisposto. Presente SOLO quando `matched` e` vero.' },
      ],
    },
    vendor: 'flowforge',
    version: '2.1.0',
  },
};

import { z } from 'zod';
import type { CanvasNode, Edge } from '@medea/engine-core-schema';

export const TemplateCategorySchema = z.enum([
  'general',
  'crm',
  'fiscalita-italia',
  'devops',
  'data-pipeline',
  'ai-orchestration',
  'monitoring',
  'communication',
]);
export type TemplateCategory = z.infer<typeof TemplateCategorySchema>;

export const TemplateLanguageSchema = z.enum(['en', 'it']);

/**
 * Tabelle dichiarate dal template, create all'instantiate nel DB locale del
 * tenant (stessa semantica del wizard scaffold: best-effort, idempotenti,
 * self-heal del databaseId). `seedRows` = righe demo inserite SOLO se la
 * tabella è stata appena creata — mai in tabelle pre-esistenti del tenant.
 * I nodi del template referenziano il DB con un `databaseId` PLACEHOLDER
 * (stesso valore in tabelle e nodi): all'instantiate viene rimappato all'id
 * reale via remapNodeDatabaseIds.
 */
export const TemplateTableSchema = z.object({
  databaseId: z.string().min(1).max(50).optional(),
  name: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/u),
  description: z.string().max(200).optional(),
  columns: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/u),
    type: z.enum(['bigint', 'boolean', 'text', 'varchar', 'integer', 'decimal', 'real', 'date', 'time', 'datetime', 'json', 'uuid']),
    nullable: z.boolean().optional(),
    unique: z.boolean().optional(),
    primaryKey: z.boolean().optional(),
  })).min(1).max(30),
  seedRows: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
});
export type TemplateTable = z.infer<typeof TemplateTableSchema>;

export const WorkflowTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string(),
  category: TemplateCategorySchema,
  tags: z.array(z.string()).default([]),
  thumbnail: z.string().optional(),
  language: TemplateLanguageSchema,
  vendor: z.string(),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
  estimatedSetupMin: z.number().int().positive(),
  requiredIntegrations: z.array(z.string()),
  /** Featured templates appear in a highlighted row at the top of the gallery. */
  featured: z.boolean().optional(),
  nodes: z.array(z.unknown()).transform((v) => v as CanvasNode[]),
  edges: z.array(z.unknown()).transform((v) => v as Edge[]),
  /** Tabelle DB create all'instantiate (vedi TemplateTableSchema). */
  tablesToCreate: z.array(TemplateTableSchema).max(5).optional(),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

/**
 * Templates are intentionally curated to surface the FlowForge Italian moat:
 * the first three target Italian PMI workflows that n8n can't replicate.
 */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  // ─── FEATURED — bot ordinazioni WhatsApp per pizzerie/ristoranti ───
  //
  // ⚠️ SINTASSI ESPRESSIONI: i riferimenti cross-nodo sono `$node.<id>.json.<campo>`
  // (→ vars["id"] nell'interprete) — NON `<id>.output.<campo>`, che NON esiste
  // nello scope (drift storico di alcuni template qui sotto, verificato E2E
  // 2026-07-06 sul tenant pizzeria).
  {
    id: 'tmpl_pizzeria_whatsapp_bot',
    name: '🍕 Pizzeria — Bot ordinazioni WhatsApp (AI)',
    description:
      'Bot completo per pizzerie/ristoranti sul numero WhatsApp Business (Meta Cloud API): il cliente scrive, '
      + 'l\'AI risponde con menu e ingredienti, riconosce "la solita" dallo storico, suggerisce pizze, prende '
      + 'l\'ordine con conferma esplicita e lo salva. Registrazione leggera: solo il numero WhatsApp (GDPR-friendly, '
      + 'informativa al primo contatto e cancellazione su richiesta). Tabelle create automaticamente: pizzeria_info '
      + '(nome, indirizzo, orari — RIEMPILA con i tuoi dati), pizzeria_menu (16 pizze di esempio da sostituire), '
      + 'pizzeria_clienti, pizzeria_ordini, pizzeria_chat.\n\n'
      + 'SETUP in 3 passi (poi abilita il workflow): (1) nodo "WhatsApp In" → scegli un Verify token e incolla '
      + 'l\'App Secret dell\'app Meta; (2) pannello Meta Business → WhatsApp → Configurazione → Webhook: URL '
      + 'https://<dominio-workspace>/webhooks/whatsapp/<id-workflow> + il tuo Verify token, sottoscrivi il campo '
      + '"messages"; (3) nodo "Rispondi su WhatsApp" → Phone Number ID + Access Token permanente. '
      + 'Personalizza menu e dati pizzeria da DB Studio.',
    category: 'communication',
    tags: ['featured', 'pizzeria', 'ristorante', 'whatsapp', 'ai', 'ordini', 'chatbot'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 20,
    featured: true,
    requiredIntegrations: ['trigger_whatsapp', 'db_query', 'db_insert', 'action_llm_complete', 'logic_if', 'action_whatsapp_send'],
    nodes: [
      { id: 'wa_in', defId: 'trigger_whatsapp', x: 60, y: 300, config: {
        verifyToken: '',
        appSecret: '',
        includeStatuses: 'false',
      } },
      { id: 'registra_cliente', defId: 'db_insert', x: 300, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_clienti',
        rowJson: '{"telefono":"{{ $node.wa_in.json.from }}","nome":{{ JSON.stringify($node.wa_in.json.profileName || "") }}}',
        onConflict: 'ignore',
      } },
      { id: 'salva_messaggio', defId: 'db_insert', x: 540, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_chat',
        rowJson: '{"telefono":"{{ $node.wa_in.json.from }}","ruolo":"cliente","messaggio":{{ JSON.stringify($node.wa_in.json.text || "") }}}',
      } },
      { id: 'info_pizzeria', defId: 'db_query', x: 780, y: 140, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_info', limit: '1',
      } },
      { id: 'carica_menu', defId: 'db_query', x: 780, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_menu',
        orderByJson: '[{"column":"id","direction":"asc"}]', limit: '50',
      } },
      { id: 'storico_ordini', defId: 'db_query', x: 1020, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_ordini',
        filtersJson: '[{"column":"telefono","op":"eq","value":"{{ $node.wa_in.json.from }}"}]',
        orderByJson: '[{"column":"id","direction":"desc"}]', limit: '5',
      } },
      { id: 'chat_recente', defId: 'db_query', x: 1260, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_chat',
        filtersJson: '[{"column":"telefono","op":"eq","value":"{{ $node.wa_in.json.from }}"}]',
        orderByJson: '[{"column":"id","direction":"desc"}]', limit: '12',
      } },
      { id: 'liara', defId: 'action_llm_complete', x: 1500, y: 300, config: {
        provider: 'liara', responseFormat: 'json', temperature: '0.4', maxTokens: '900',
        systemPrompt:
          'Sei l\'assistente WhatsApp della pizzeria descritta in DATI PIZZERIA. Rispondi SEMPRE e SOLO con un '
          + 'oggetto JSON valido:\n{"risposta": "<testo del messaggio WhatsApp per il cliente>", "ordine": null | '
          + '{"pizze":[{"nome":"...","quantita":N,"prezzo_unitario":X.X}],"totale":X.X,'
          + '"note":"<asporto/consegna, orario, indirizzo>"}}\n\nREGOLE:\n'
          + '- Presentati e firma col nome della pizzeria in DATI PIZZERIA; usa indirizzo/orari da lì quando richiesti. '
          + 'Se DATI PIZZERIA è vuoto, resta generico e non inventare.\n'
          + '- Parla italiano, tono cordiale e concreto da pizzeria, emoji con moderazione.\n'
          + '- Il MENU nel contesto è l\'UNICA fonte: proponi solo pizze del menu e usa SOLO i prezzi del menu. '
          + 'Pizza fuori menu → dillo e proponi la più simile. MENU vuoto → spiega che il menu non è ancora caricato.\n'
          + '- Menu o ingredienti richiesti → elenca leggibile: nome — ingredienti — prezzo €.\n'
          + '- "La solita" → guarda ULTIMI ORDINI e riproponi l\'ultimo ordine chiedendo conferma.\n'
          + '- Cliente indeciso → proponi 1-2 pizze in base ai suoi ordini passati (o le classiche se nuovo).\n'
          + '- ORDINE: compila "ordine" SOLO quando il cliente ha CONFERMATO esplicitamente il riepilogo (pizze, '
          + 'quantità, totale, asporto/consegna e orario). Prima chiedi conferma col riepilogo e lascia "ordine": null.\n'
          + '- Quando compili "ordine", in "risposta" conferma con totale e tempi indicativi.\n'
          + '- PRIMO contatto (conversazione recente vuota) → presenta la pizzeria in una riga e aggiungi: '
          + '"Conserviamo il tuo numero e lo storico ordini solo per gestire le ordinazioni; scrivi CANCELLA per farli eliminare."\n'
          + '- Cliente scrive CANCELLA → rispondi che la richiesta di cancellazione è presa in carico, "ordine": null.\n'
          + '- Mai inventare disponibilità, sconti o tempi non indicati. Fuori tema → riporta gentilmente al menu.',
        prompt:
          'MESSAGGIO CLIENTE: {{ $node.wa_in.json.text }}\n'
          + 'TIPO MESSAGGIO: {{ $node.wa_in.json.type }}\n'
          + 'PROFILO: {{ $node.wa_in.json.profileName }} (telefono {{ $node.wa_in.json.from }})\n\n'
          + 'DATI PIZZERIA (JSON): {{ JSON.stringify($node.info_pizzeria.json.rows) }}\n\n'
          + 'MENU (JSON): {{ JSON.stringify($node.carica_menu.json.rows) }}\n\n'
          + 'ULTIMI ORDINI DEL CLIENTE (JSON, dal più recente): {{ JSON.stringify($node.storico_ordini.json.rows) }}\n\n'
          + 'CONVERSAZIONE RECENTE (JSON, dal più recente): {{ JSON.stringify($node.chat_recente.json.rows) }}',
      } },
      { id: 'salva_risposta', defId: 'db_insert', x: 1740, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_chat',
        rowJson: '{"telefono":"{{ $node.wa_in.json.from }}","ruolo":"pizzeria","messaggio":{{ JSON.stringify(($node.liara.json.jsonParsed || {}).risposta || $node.liara.json.completion || "") }}}',
      } },
      { id: 'gate_ordine', defId: 'logic_if', x: 1980, y: 300, config: {
        condition: '($node.liara.json.jsonParsed || {}).ordine != null',
      } },
      { id: 'salva_ordine', defId: 'db_insert', x: 2220, y: 160, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_ordini',
        rowJson: '{"telefono":"{{ $node.wa_in.json.from }}",'
          + '"pizze":{{ JSON.stringify(JSON.stringify($node.liara.json.jsonParsed.ordine.pizze || [])) }},'
          + '"totale":{{ $node.liara.json.jsonParsed.ordine.totale || 0 }},'
          + '"stato":"ricevuto",'
          + '"note":{{ JSON.stringify($node.liara.json.jsonParsed.ordine.note || "") }}}',
      } },
      { id: 'rispondi', defId: 'action_whatsapp_send', x: 2460, y: 300, config: {
        phoneNumberId: '',
        accessToken: '',
        recipient: '+{{ $node.wa_in.json.from }}',
        mode: 'text',
        body: '{{ ($node.liara.json.jsonParsed || {}).risposta || $node.liara.json.completion }}',
      } },
    ],
    edges: [
      { from: 'wa_in', to: 'registra_cliente' },
      { from: 'registra_cliente', to: 'salva_messaggio' },
      { from: 'salva_messaggio', to: 'info_pizzeria' },
      { from: 'info_pizzeria', to: 'carica_menu' },
      { from: 'carica_menu', to: 'storico_ordini' },
      { from: 'storico_ordini', to: 'chat_recente' },
      { from: 'chat_recente', to: 'liara' },
      { from: 'liara', to: 'salva_risposta' },
      { from: 'salva_risposta', to: 'gate_ordine' },
      { from: 'gate_ordine', to: 'salva_ordine', fromPort: 'true' },
      { from: 'salva_ordine', to: 'rispondi' },
      { from: 'gate_ordine', to: 'rispondi', fromPort: 'false' },
    ],
    tablesToCreate: [
      {
        databaseId: 'pizzeria_db',
        name: 'pizzeria_info',
        description: 'Anagrafica della pizzeria: nome, indirizzo, orari, contatti. UNA riga.',
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'nome', type: 'text', nullable: false },
          { name: 'indirizzo', type: 'text' },
          { name: 'telefono', type: 'text' },
          { name: 'orari', type: 'text' },
          { name: 'consegna_minuti', type: 'integer' },
          { name: 'note', type: 'text' },
        ],
        seedRows: [
          { id: 1, nome: 'Pizzeria Da Esempio', indirizzo: 'Via Roma 1, Città', telefono: '+39 06 1234567', orari: 'mar-dom 18:30-23:00, lunedì chiuso', consegna_minuti: 30, note: 'SOSTITUISCI questi dati con quelli reali della pizzeria (DB Studio → pizzeria_info)' },
        ],
      },
      {
        databaseId: 'pizzeria_db',
        name: 'pizzeria_menu',
        description: 'Menu pizze: nome, ingredienti, prezzo. Righe di esempio da sostituire.',
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'nome', type: 'text', nullable: false },
          { name: 'ingredienti', type: 'text', nullable: false },
          { name: 'prezzo', type: 'real', nullable: false },
          { name: 'disponibile', type: 'boolean', nullable: false },
        ],
        seedRows: [
          { id: 1, nome: 'Margherita', ingredienti: 'pomodoro, mozzarella, basilico', prezzo: 6.5, disponibile: 1 },
          { id: 2, nome: 'Marinara', ingredienti: 'pomodoro, aglio, origano, olio EVO', prezzo: 5.5, disponibile: 1 },
          { id: 3, nome: 'Diavola', ingredienti: 'pomodoro, mozzarella, salame piccante', prezzo: 8.0, disponibile: 1 },
          { id: 4, nome: 'Capricciosa', ingredienti: 'pomodoro, mozzarella, prosciutto cotto, funghi, carciofi, olive', prezzo: 9.0, disponibile: 1 },
          { id: 5, nome: 'Quattro Stagioni', ingredienti: 'pomodoro, mozzarella, prosciutto cotto, funghi, carciofi, olive a spicchi', prezzo: 9.0, disponibile: 1 },
          { id: 6, nome: 'Quattro Formaggi', ingredienti: 'mozzarella, gorgonzola, fontina, parmigiano', prezzo: 9.0, disponibile: 1 },
          { id: 7, nome: 'Prosciutto e Funghi', ingredienti: 'pomodoro, mozzarella, prosciutto cotto, funghi', prezzo: 8.5, disponibile: 1 },
          { id: 8, nome: 'Napoletana', ingredienti: 'pomodoro, mozzarella, acciughe, capperi, origano', prezzo: 8.0, disponibile: 1 },
          { id: 9, nome: 'Bufalina', ingredienti: 'pomodoro, mozzarella di bufala, basilico', prezzo: 9.5, disponibile: 1 },
          { id: 10, nome: 'Ortolana', ingredienti: 'pomodoro, mozzarella, verdure grigliate', prezzo: 8.5, disponibile: 1 },
          { id: 11, nome: 'Tonno e Cipolla', ingredienti: 'pomodoro, mozzarella, tonno, cipolla rossa', prezzo: 8.5, disponibile: 1 },
          { id: 12, nome: 'Salsiccia e Friarielli', ingredienti: 'mozzarella, salsiccia, friarielli', prezzo: 9.5, disponibile: 1 },
          { id: 13, nome: 'Boscaiola', ingredienti: 'mozzarella, funghi porcini, salsiccia', prezzo: 10.0, disponibile: 1 },
          { id: 14, nome: 'Calzone Classico', ingredienti: 'pomodoro, mozzarella, prosciutto cotto, ricotta (chiuso al forno)', prezzo: 9.0, disponibile: 1 },
          { id: 15, nome: 'Parmigiana', ingredienti: 'pomodoro, mozzarella, melanzane fritte, parmigiano', prezzo: 9.0, disponibile: 1 },
          { id: 16, nome: 'Crudo e Rucola', ingredienti: 'pomodoro, mozzarella, prosciutto crudo, rucola, scaglie di grana', prezzo: 10.0, disponibile: 1 },
        ],
      },
      {
        databaseId: 'pizzeria_db',
        name: 'pizzeria_clienti',
        description: 'Clienti registrati col solo numero WhatsApp (registrazione leggera GDPR).',
        columns: [
          { name: 'telefono', type: 'text', primaryKey: true, nullable: false },
          { name: 'nome', type: 'text' },
          { name: 'creato_il', type: 'datetime' },
        ],
      },
      {
        databaseId: 'pizzeria_db',
        name: 'pizzeria_ordini',
        description: 'Storico ordini per cliente (pizze in JSON) — alimenta "la solita" e i suggerimenti.',
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'telefono', type: 'text', nullable: false },
          { name: 'pizze', type: 'text', nullable: false },
          { name: 'totale', type: 'real' },
          { name: 'stato', type: 'text' },
          { name: 'note', type: 'text' },
          { name: 'creato_il', type: 'datetime' },
        ],
      },
      {
        databaseId: 'pizzeria_db',
        name: 'pizzeria_chat',
        description: 'Log conversazione WhatsApp per il contesto dell\'AI.',
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'telefono', type: 'text', nullable: false },
          { name: 'ruolo', type: 'text', nullable: false },
          { name: 'messaggio', type: 'text' },
          { name: 'creato_il', type: 'datetime' },
        ],
      },
    ],
  },

  // ─── Variante Telegram del bot pizzeria — canale DEMO (bot in 2 minuti) ───
  //
  // Stesse tabelle del gemello WhatsApp (placeholder pizzeria_db identico:
  // se installi entrambi, il secondo riusa le tabelle esistenti e SALTA i
  // seed). Chiave cliente = chatId Telegram salvato nella colonna `telefono`
  // (dichiarato in description: le due chiavi non collidono — formati diversi).
  {
    id: 'tmpl_pizzeria_telegram_bot',
    name: '🍕 Pizzeria — Bot ordinazioni Telegram (demo in 5 minuti)',
    description:
      'La variante Telegram del bot pizzeria: stesso cervello AI e stesse tabelle del template WhatsApp, ma sul '
      + 'canale più rapido da attivare — il bot si crea con @BotFather in 2 minuti, senza verifica aziendale né '
      + 'costi. Perfetto per DEMO dal vivo: crei il bot col nome della pizzeria, colleghi il webhook e il '
      + 'pizzaiolo lo prova subito dal suo telefono. La chiave cliente è la chat Telegram (salvata nella colonna '
      + 'telefono delle tabelle condivise).\n\n'
      + 'SETUP: (1) @BotFather → /newbot → copia il token e collegalo in Impostazioni → Integrazioni (Telegram); '
      + '(2) nodo "Telegram In" → scegli un Secret token; (3) registra il webhook: '
      + 'https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<dominio-workspace>/webhooks/telegram/'
      + '<id-workflow>&secret_token=<il-tuo-secret>; (4) abilita il workflow. Menu e dati pizzeria si '
      + 'personalizzano da DB Studio (pizzeria_menu, pizzeria_info).',
    category: 'communication',
    tags: ['featured', 'pizzeria', 'ristorante', 'telegram', 'ai', 'ordini', 'chatbot', 'demo'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 5,
    featured: true,
    requiredIntegrations: ['trigger_telegram', 'db_query', 'db_insert', 'action_llm_complete', 'logic_if', 'integration_telegram_send'],
    nodes: [
      { id: 'tg_in', defId: 'trigger_telegram', x: 60, y: 300, config: {
        secretToken: '',
        includeEdited: 'false',
      } },
      { id: 'registra_cliente', defId: 'db_insert', x: 300, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_clienti',
        rowJson: '{"telefono":"{{ $node.tg_in.json.chatId }}","nome":{{ JSON.stringify($node.tg_in.json.firstName || $node.tg_in.json.username || "") }}}',
        onConflict: 'ignore',
      } },
      { id: 'salva_messaggio', defId: 'db_insert', x: 540, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_chat',
        rowJson: '{"telefono":"{{ $node.tg_in.json.chatId }}","ruolo":"cliente","messaggio":{{ JSON.stringify($node.tg_in.json.text || "") }}}',
      } },
      { id: 'info_pizzeria', defId: 'db_query', x: 780, y: 140, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_info', limit: '1',
      } },
      { id: 'carica_menu', defId: 'db_query', x: 780, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_menu',
        orderByJson: '[{"column":"id","direction":"asc"}]', limit: '50',
      } },
      { id: 'storico_ordini', defId: 'db_query', x: 1020, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_ordini',
        filtersJson: '[{"column":"telefono","op":"eq","value":"{{ $node.tg_in.json.chatId }}"}]',
        orderByJson: '[{"column":"id","direction":"desc"}]', limit: '5',
      } },
      { id: 'chat_recente', defId: 'db_query', x: 1260, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_chat',
        filtersJson: '[{"column":"telefono","op":"eq","value":"{{ $node.tg_in.json.chatId }}"}]',
        orderByJson: '[{"column":"id","direction":"desc"}]', limit: '12',
      } },
      { id: 'liara', defId: 'action_llm_complete', x: 1500, y: 300, config: {
        provider: 'liara', responseFormat: 'json', temperature: '0.4', maxTokens: '900',
        systemPrompt:
          'Sei l\'assistente Telegram della pizzeria descritta in DATI PIZZERIA. Rispondi SEMPRE e SOLO con un '
          + 'oggetto JSON valido:\n{"risposta": "<testo del messaggio per il cliente>", "ordine": null | '
          + '{"pizze":[{"nome":"...","quantita":N,"prezzo_unitario":X.X}],"totale":X.X,'
          + '"note":"<asporto/consegna, orario, indirizzo>"}}\n\nREGOLE:\n'
          + '- Presentati e firma col nome della pizzeria in DATI PIZZERIA; usa indirizzo/orari da lì quando richiesti. '
          + 'Se DATI PIZZERIA è vuoto, resta generico e non inventare.\n'
          + '- Parla italiano, tono cordiale e concreto da pizzeria, emoji con moderazione.\n'
          + '- Il MENU nel contesto è l\'UNICA fonte: proponi solo pizze del menu e usa SOLO i prezzi del menu. '
          + 'Pizza fuori menu → dillo e proponi la più simile. MENU vuoto → spiega che il menu non è ancora caricato.\n'
          + '- Menu o ingredienti richiesti → elenca leggibile: nome — ingredienti — prezzo €.\n'
          + '- "La solita" → guarda ULTIMI ORDINI e riproponi l\'ultimo ordine chiedendo conferma.\n'
          + '- Cliente indeciso → proponi 1-2 pizze in base ai suoi ordini passati (o le classiche se nuovo).\n'
          + '- ORDINE: compila "ordine" SOLO quando il cliente ha CONFERMATO esplicitamente il riepilogo (pizze, '
          + 'quantità, totale, asporto/consegna e orario). Prima chiedi conferma col riepilogo e lascia "ordine": null.\n'
          + '- Quando compili "ordine", in "risposta" conferma con totale e tempi indicativi.\n'
          + '- PRIMO contatto (conversazione recente vuota) → presenta la pizzeria in una riga e aggiungi: '
          + '"Conserviamo il tuo contatto e lo storico ordini solo per gestire le ordinazioni; scrivi CANCELLA per farli eliminare."\n'
          + '- Cliente scrive CANCELLA → rispondi che la richiesta di cancellazione è presa in carico, "ordine": null.\n'
          + '- Mai inventare disponibilità, sconti o tempi non indicati. Fuori tema → riporta gentilmente al menu.',
        prompt:
          'MESSAGGIO CLIENTE: {{ $node.tg_in.json.text }}\n'
          + 'TIPO: {{ $node.tg_in.json.kind }}\n'
          + 'PROFILO: {{ $node.tg_in.json.firstName }} (@{{ $node.tg_in.json.username }}, chat {{ $node.tg_in.json.chatId }})\n\n'
          + 'DATI PIZZERIA (JSON): {{ JSON.stringify($node.info_pizzeria.json.rows) }}\n\n'
          + 'MENU (JSON): {{ JSON.stringify($node.carica_menu.json.rows) }}\n\n'
          + 'ULTIMI ORDINI DEL CLIENTE (JSON, dal più recente): {{ JSON.stringify($node.storico_ordini.json.rows) }}\n\n'
          + 'CONVERSAZIONE RECENTE (JSON, dal più recente): {{ JSON.stringify($node.chat_recente.json.rows) }}',
      } },
      { id: 'salva_risposta', defId: 'db_insert', x: 1740, y: 300, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_chat',
        rowJson: '{"telefono":"{{ $node.tg_in.json.chatId }}","ruolo":"pizzeria","messaggio":{{ JSON.stringify(($node.liara.json.jsonParsed || {}).risposta || $node.liara.json.completion || "") }}}',
      } },
      { id: 'gate_ordine', defId: 'logic_if', x: 1980, y: 300, config: {
        condition: '($node.liara.json.jsonParsed || {}).ordine != null',
      } },
      { id: 'salva_ordine', defId: 'db_insert', x: 2220, y: 160, config: {
        databaseId: 'pizzeria_db', table: 'pizzeria_ordini',
        rowJson: '{"telefono":"{{ $node.tg_in.json.chatId }}",'
          + '"pizze":{{ JSON.stringify(JSON.stringify($node.liara.json.jsonParsed.ordine.pizze || [])) }},'
          + '"totale":{{ $node.liara.json.jsonParsed.ordine.totale || 0 }},'
          + '"stato":"ricevuto",'
          + '"note":{{ JSON.stringify($node.liara.json.jsonParsed.ordine.note || "") }}}',
      } },
      { id: 'rispondi', defId: 'integration_telegram_send', x: 2460, y: 300, config: {
        chatId: '{{ $node.tg_in.json.chatId }}',
        text: '{{ ($node.liara.json.jsonParsed || {}).risposta || $node.liara.json.completion }}',
      } },
    ],
    edges: [
      { from: 'tg_in', to: 'registra_cliente' },
      { from: 'registra_cliente', to: 'salva_messaggio' },
      { from: 'salva_messaggio', to: 'info_pizzeria' },
      { from: 'info_pizzeria', to: 'carica_menu' },
      { from: 'carica_menu', to: 'storico_ordini' },
      { from: 'storico_ordini', to: 'chat_recente' },
      { from: 'chat_recente', to: 'liara' },
      { from: 'liara', to: 'salva_risposta' },
      { from: 'salva_risposta', to: 'gate_ordine' },
      { from: 'gate_ordine', to: 'salva_ordine', fromPort: 'true' },
      { from: 'salva_ordine', to: 'rispondi' },
      { from: 'gate_ordine', to: 'rispondi', fromPort: 'false' },
    ],
    // Stesse tabelle del gemello WhatsApp (placeholder identico → se già
    // installate vengono riusate, seed saltati).
    tablesToCreate: [
      {
        databaseId: 'pizzeria_db',
        name: 'pizzeria_info',
        description: 'Anagrafica della pizzeria: nome, indirizzo, orari, contatti. UNA riga.',
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'nome', type: 'text', nullable: false },
          { name: 'indirizzo', type: 'text' },
          { name: 'telefono', type: 'text' },
          { name: 'orari', type: 'text' },
          { name: 'consegna_minuti', type: 'integer' },
          { name: 'note', type: 'text' },
        ],
        seedRows: [
          { id: 1, nome: 'Pizzeria Da Esempio', indirizzo: 'Via Roma 1, Città', telefono: '+39 06 1234567', orari: 'mar-dom 18:30-23:00, lunedì chiuso', consegna_minuti: 30, note: 'SOSTITUISCI questi dati con quelli reali della pizzeria (DB Studio → pizzeria_info)' },
        ],
      },
      {
        databaseId: 'pizzeria_db',
        name: 'pizzeria_menu',
        description: 'Menu pizze: nome, ingredienti, prezzo. Righe di esempio da sostituire.',
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'nome', type: 'text', nullable: false },
          { name: 'ingredienti', type: 'text', nullable: false },
          { name: 'prezzo', type: 'real', nullable: false },
          { name: 'disponibile', type: 'boolean', nullable: false },
        ],
        seedRows: [
          { id: 1, nome: 'Margherita', ingredienti: 'pomodoro, mozzarella, basilico', prezzo: 6.5, disponibile: 1 },
          { id: 2, nome: 'Marinara', ingredienti: 'pomodoro, aglio, origano, olio EVO', prezzo: 5.5, disponibile: 1 },
          { id: 3, nome: 'Diavola', ingredienti: 'pomodoro, mozzarella, salame piccante', prezzo: 8.0, disponibile: 1 },
          { id: 4, nome: 'Capricciosa', ingredienti: 'pomodoro, mozzarella, prosciutto cotto, funghi, carciofi, olive', prezzo: 9.0, disponibile: 1 },
          { id: 5, nome: 'Quattro Stagioni', ingredienti: 'pomodoro, mozzarella, prosciutto cotto, funghi, carciofi, olive a spicchi', prezzo: 9.0, disponibile: 1 },
          { id: 6, nome: 'Quattro Formaggi', ingredienti: 'mozzarella, gorgonzola, fontina, parmigiano', prezzo: 9.0, disponibile: 1 },
          { id: 7, nome: 'Prosciutto e Funghi', ingredienti: 'pomodoro, mozzarella, prosciutto cotto, funghi', prezzo: 8.5, disponibile: 1 },
          { id: 8, nome: 'Napoletana', ingredienti: 'pomodoro, mozzarella, acciughe, capperi, origano', prezzo: 8.0, disponibile: 1 },
          { id: 9, nome: 'Bufalina', ingredienti: 'pomodoro, mozzarella di bufala, basilico', prezzo: 9.5, disponibile: 1 },
          { id: 10, nome: 'Ortolana', ingredienti: 'pomodoro, mozzarella, verdure grigliate', prezzo: 8.5, disponibile: 1 },
          { id: 11, nome: 'Tonno e Cipolla', ingredienti: 'pomodoro, mozzarella, tonno, cipolla rossa', prezzo: 8.5, disponibile: 1 },
          { id: 12, nome: 'Salsiccia e Friarielli', ingredienti: 'mozzarella, salsiccia, friarielli', prezzo: 9.5, disponibile: 1 },
          { id: 13, nome: 'Boscaiola', ingredienti: 'mozzarella, funghi porcini, salsiccia', prezzo: 10.0, disponibile: 1 },
          { id: 14, nome: 'Calzone Classico', ingredienti: 'pomodoro, mozzarella, prosciutto cotto, ricotta (chiuso al forno)', prezzo: 9.0, disponibile: 1 },
          { id: 15, nome: 'Parmigiana', ingredienti: 'pomodoro, mozzarella, melanzane fritte, parmigiano', prezzo: 9.0, disponibile: 1 },
          { id: 16, nome: 'Crudo e Rucola', ingredienti: 'pomodoro, mozzarella, prosciutto crudo, rucola, scaglie di grana', prezzo: 10.0, disponibile: 1 },
        ],
      },
      {
        databaseId: 'pizzeria_db',
        name: 'pizzeria_clienti',
        description: 'Clienti registrati (chiave: numero WhatsApp o chat Telegram).',
        columns: [
          { name: 'telefono', type: 'text', primaryKey: true, nullable: false },
          { name: 'nome', type: 'text' },
          { name: 'creato_il', type: 'datetime' },
        ],
      },
      {
        databaseId: 'pizzeria_db',
        name: 'pizzeria_ordini',
        description: 'Storico ordini per cliente (pizze in JSON) — alimenta "la solita" e i suggerimenti.',
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'telefono', type: 'text', nullable: false },
          { name: 'pizze', type: 'text', nullable: false },
          { name: 'totale', type: 'real' },
          { name: 'stato', type: 'text' },
          { name: 'note', type: 'text' },
          { name: 'creato_il', type: 'datetime' },
        ],
      },
      {
        databaseId: 'pizzeria_db',
        name: 'pizzeria_chat',
        description: 'Log conversazione per il contesto dell\'AI.',
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'telefono', type: 'text', nullable: false },
          { name: 'ruolo', type: 'text', nullable: false },
          { name: 'messaggio', type: 'text' },
          { name: 'creato_il', type: 'datetime' },
        ],
      },
    ],
  },

  // ─── FEATURED — primo workflow funzionante out-of-the-box ───
  {
    id: 'tmpl_featured_webhook_slack',
    name: '⭐ Webhook → Slack (parti da qui)',
    description:
      'Il workflow più semplice possibile: ricevi una richiesta HTTP e mandi un messaggio Slack. Già configurato — basta cambiare il webhook URL di Slack e cliccare Esegui. Tempo: 60 secondi.',
    category: 'general',
    tags: ['featured', 'starter', 'webhook', 'slack', 'easy'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 1,
    featured: true,
    requiredIntegrations: ['trigger_webhook', 'action_http'],
    nodes: [
      {
        id: 'webhook',
        defId: 'trigger_webhook',
        x: 0,
        y: 0,
        config: {
          path: 'incoming',
          method: 'POST',
          authMode: 'none',
        },
      },
      {
        id: 'slack',
        defId: 'action_http',
        x: 240,
        y: 0,
        config: {
          url: 'https://hooks.slack.com/services/SOSTITUISCI/CON/IL_TUO_WEBHOOK',
          method: 'POST',
          headersJson: '{"Content-Type":"application/json"}',
          body: '{"text":"Webhook ricevuto: {{ JSON.stringify(input) }}"}',
          timeoutMs: '10000',
        },
      },
    ],
    edges: [
      { from: 'webhook', to: 'slack' },
    ],
  },
  {
    id: 'tmpl_it_invoice_to_sdi',
    name: 'Da webhook a fattura SDI in 5 step',
    description: "Ricevi un webhook con dati cliente + ordine, crea il cliente su Fatture in Cloud se non esiste, emette la fattura, la trasmette al Sistema di Interscambio (SDI) e invia conferma per PEC.",
    category: 'fiscalita-italia',
    tags: ['SDI', 'FatturaPA', 'PEC', 'Italia', 'fatturazione'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 25,
    requiredIntegrations: ['italia_fatture_in_cloud_invoice', 'italia_fatture_in_cloud_client', 'italia_sdi_send_invoice', 'italia_pec_aruba_send'],
    nodes: [
      { id: 'trig', defId: 'trigger_webhook', x: 0, y: 0, config: { method: 'POST', authMode: 'hmac-signature' } },
      { id: 'lookup', defId: 'italia_fatture_in_cloud_client', x: 220, y: 0, config: { createIfMissing: 'true' } },
      { id: 'invoice', defId: 'italia_fatture_in_cloud_invoice', x: 440, y: 0, config: {} },
      { id: 'sdi', defId: 'italia_sdi_send_invoice', x: 660, y: 0, config: { environment: 'production' } },
      { id: 'notify', defId: 'italia_pec_aruba_send', x: 880, y: 0, config: { subject: 'Fattura trasmessa' } },
    ],
    edges: [
      { from: 'trig', to: 'lookup' },
      { from: 'lookup', to: 'invoice' },
      { from: 'invoice', to: 'sdi' },
      { from: 'sdi', to: 'notify' },
    ],
  },
  {
    id: 'tmpl_it_pec_to_drive',
    name: 'Archivio PEC → cartella aziendale',
    description: 'Ogni nuovo messaggio PEC ricevuto viene salvato in una cartella organizzata per mittente e mese.',
    category: 'fiscalita-italia',
    tags: ['PEC', 'archiviazione', 'Italia'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 10,
    requiredIntegrations: ['italia_pec_aruba_receive', 'action_file_write'],
    nodes: [
      { id: 'pec', defId: 'italia_pec_aruba_receive', x: 0, y: 0, config: { pollIntervalSec: '60' } },
      { id: 'write', defId: 'action_file_write', x: 200, y: 0, config: { mode: 'overwrite' } },
    ],
    edges: [{ from: 'pec', to: 'write' }],
  },
  {
    id: 'tmpl_ai_summarize_endpoint',
    name: 'AI Summarize HTTP endpoint',
    description: 'Webhook → AI summarize → return JSON. Minimal pattern for an AI-backed HTTP API.',
    category: 'ai-orchestration',
    tags: ['AI', 'webhook', 'summarize'],
    language: 'en',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 5,
    requiredIntegrations: ['trigger_webhook', 'agent_summarizer'],
    nodes: [
      { id: 'wh', defId: 'trigger_webhook', x: 0, y: 0, config: { method: 'POST' } },
      { id: 'sum', defId: 'agent_summarizer', x: 200, y: 0, config: {} },
    ],
    edges: [{ from: 'wh', to: 'sum' }],
  },
  {
    id: 'tmpl_cron_daily_db_report',
    name: 'Daily DB report → email',
    description: 'Every weekday at 9am, run a DB query against the user metrics table, summarize the rows with AI, and send the report by email.',
    category: 'monitoring',
    tags: ['cron', 'db', 'report', 'AI'],
    language: 'en',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 15,
    requiredIntegrations: ['trigger_cron', 'db_query', 'agent_summarizer'],
    nodes: [
      { id: 'cron', defId: 'trigger_cron', x: 0, y: 0, config: { cronExpression: '0 9 * * 1-5', timezone: 'Europe/Rome' } },
      { id: 'q', defId: 'db_query', x: 200, y: 0, config: { table: 'metrics' } },
      { id: 'sum', defId: 'agent_summarizer', x: 400, y: 0, config: {} },
    ],
    edges: [
      { from: 'cron', to: 'q' },
      { from: 'q', to: 'sum' },
    ],
  },
  {
    id: 'tmpl_webhook_to_slack',
    name: 'GitHub webhook → Slack notification',
    description: 'Receive a GitHub push event, filter for relevant branches, post to Slack.',
    category: 'devops',
    tags: ['github', 'slack', 'webhook'],
    language: 'en',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 8,
    requiredIntegrations: ['trigger_webhook', 'logic_if', 'action_http'],
    nodes: [
      { id: 'wh', defId: 'trigger_webhook', x: 0, y: 0, config: { method: 'POST', authMode: 'hmac-signature' } },
      { id: 'gate', defId: 'logic_if', x: 220, y: 0, config: { condition: 'input.body.ref === "refs/heads/main"' } },
      { id: 'post', defId: 'action_http', x: 440, y: 0, config: { method: 'POST' } },
    ],
    edges: [
      { from: 'wh', to: 'gate' },
      { from: 'gate', to: 'post', fromPort: 'true' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // TIER 1 — TEMPLATES DI TEST TECNICO
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 'tmpl_test_http_get',
    name: '🧪 Test: HTTP request (GET/POST)',
    description: 'Verifica che il nodo action_http funzioni: GET httpbin.org/json + POST httpbin.org/post.',
    category: 'general',
    tags: ['test', 'http'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 2,
    requiredIntegrations: ['trigger_manual', 'action_http'],
    nodes: [
      { id: 'start', defId: 'trigger_manual', x: 0, y: 0, config: {} },
      { id: 'http_get', defId: 'action_http', x: 220, y: 0, config: { url: 'https://httpbin.org/json', method: 'GET' } },
      { id: 'http_post', defId: 'action_http', x: 440, y: 0, config: { url: 'https://httpbin.org/post', method: 'POST', body: '{{http_get.output.body}}' } },
    ],
    edges: [
      { from: 'start', to: 'http_get' },
      { from: 'http_get', to: 'http_post' },
    ],
  },
  {
    id: 'tmpl_test_db_crud',
    name: '🧪 Test: DB CRUD completo',
    description: 'Test insert + query + update + delete su una tabella esistente. Richiede un DB FlowForge con tabella.',
    category: 'data-pipeline',
    tags: ['test', 'db'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 5,
    requiredIntegrations: ['trigger_manual', 'db_insert', 'db_query', 'db_update', 'db_delete'],
    nodes: [
      { id: 'start', defId: 'trigger_manual', x: 0, y: 0, config: {} },
      { id: 'ins', defId: 'db_insert', x: 220, y: 0, config: { rowJson: '{"date":"2026-06-01","page_views":999,"signups":99,"revenue":999.99}' } },
      { id: 'sel', defId: 'db_query', x: 440, y: 0, config: { limit: '10' } },
      { id: 'upd', defId: 'db_update', x: 660, y: 0, config: { whereJson: '{"date":"2026-06-01"}', patchJson: '{"page_views":1234}' } },
      { id: 'del', defId: 'db_delete', x: 880, y: 0, config: { whereJson: '{"date":"2026-06-01"}' } },
    ],
    edges: [
      { from: 'start', to: 'ins' },
      { from: 'ins', to: 'sel' },
      { from: 'sel', to: 'upd' },
      { from: 'upd', to: 'del' },
    ],
  },
  {
    id: 'tmpl_test_file_rw',
    name: '🧪 Test: File Read/Write',
    description: 'Scrive un file nel namespace del tuo tenant e poi lo rilegge per verifica. I path relativi vengono risolti dentro la cartella del cliente, isolata dagli altri.',
    category: 'general',
    tags: ['test', 'file'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 3,
    requiredIntegrations: ['trigger_manual', 'action_file_write', 'action_file_read'],
    nodes: [
      { id: 'start', defId: 'trigger_manual', x: 0, y: 0, config: {} },
      { id: 'write', defId: 'action_file_write', x: 220, y: 0, config: { path: 'test.json', content: '{"hello":"flowforge","timestamp":"{{ctx.runId}}"}', mode: 'overwrite' } },
      { id: 'read', defId: 'action_file_read', x: 440, y: 0, config: { path: 'test.json' } },
    ],
    edges: [
      { from: 'start', to: 'write' },
      { from: 'write', to: 'read' },
    ],
  },
  {
    id: 'tmpl_test_logic_flow',
    name: '🧪 Test: Logic If / Delay / Loop (true iteration)',
    description:
      'Loop iterativo VERO: array di 5 elementi → body (If pari/dispari + Delay) per ogni item → done con sommario. Dimostra loop.item, loop.index, body/done branching.',
    category: 'general',
    tags: ['test', 'logic', 'loop', 'iteration'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 5,
    featured: true,
    requiredIntegrations: ['trigger_manual', 'logic_loop', 'logic_if', 'logic_delay', 'logic_transform'],
    nodes: [
      { id: 'start', defId: 'trigger_manual', x: 0, y: 0, config: {} },
      {
        id: 'loop',
        defId: 'logic_loop',
        x: 220,
        y: 0,
        config: {
          itemsExpression: '[1,2,3,4,5]',
          strategy: 'naive',
          concurrency: '1',
          errorPolicy: 'continue',
          maxItems: '1000',
        },
      },
      {
        id: 'iff',
        defId: 'logic_if',
        x: 440,
        y: -80,
        config: { condition: 'loop.item % 2 === 0' },
      },
      {
        id: 'delay',
        defId: 'logic_delay',
        x: 660,
        y: -80,
        config: { durationMs: '50' },
      },
      {
        id: 'summary',
        defId: 'logic_transform',
        x: 440,
        y: 120,
        config: {
          expression:
            '{ "iterations": input.iterations, "succeeded": input.succeeded, "strategy": input.strategy, "totalMs": input.totalDurationMs }',
        },
      },
    ],
    edges: [
      { from: 'start', to: 'loop' },
      { from: 'loop', to: 'iff', fromPort: 'body' },
      { from: 'iff', to: 'delay', fromPort: 'true' },
      { from: 'loop', to: 'summary', fromPort: 'done' },
    ],
  },
  {
    id: 'tmpl_test_loop_aggregate',
    name: '🧪 Test: Loop con Aggregate (group_by + sum)',
    description:
      'Mostra il PATTERN ENTERPRISE: 50 ordini → group_by customer → aggregate sum → bulk action. Dimostra come ridurre 50 iterazioni a 5 senza perdere semantica business.',
    category: 'data-pipeline',
    tags: ['test', 'loop', 'aggregate', 'enterprise'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 5,
    requiredIntegrations: ['trigger_manual', 'logic_aggregate', 'logic_loop'],
    nodes: [
      {
        id: 'start',
        defId: 'trigger_manual',
        x: 0,
        y: 0,
        config: {
          sampleInput:
            '[{"customer":"A","amount":100},{"customer":"B","amount":50},{"customer":"A","amount":75},{"customer":"C","amount":200},{"customer":"B","amount":25}]',
        },
      },
      {
        id: 'agg',
        defId: 'logic_aggregate',
        x: 220,
        y: 0,
        config: {
          sourceExpression: 'input',
          reducer: 'sum',
          field: 'amount',
          groupBy: 'customer',
        },
      },
      {
        id: 'loop',
        defId: 'logic_loop',
        x: 440,
        y: 0,
        config: {
          itemsExpression: 'Object.entries(input.reduced).map(([k,v]) => ({customer: k, total: v}))',
          strategy: 'naive',
          concurrency: '1',
          errorPolicy: 'continue',
          maxItems: '100',
        },
      },
      {
        id: 'fmt',
        defId: 'logic_transform',
        x: 660,
        y: -80,
        config: {
          expression: '{ "msg": "Customer " & loop.item.customer & " spent " & $string(loop.item.total) }',
        },
      },
      {
        id: 'done',
        defId: 'logic_transform',
        x: 660,
        y: 120,
        config: {
          expression: '{ "summary": "Processed " & $string(input.iterations) & " customers in " & $string(input.totalDurationMs) & "ms" }',
        },
      },
    ],
    edges: [
      { from: 'start', to: 'agg' },
      { from: 'agg', to: 'loop' },
      { from: 'loop', to: 'fmt', fromPort: 'body' },
      { from: 'loop', to: 'done', fromPort: 'done' },
    ],
  },
  {
    id: 'tmpl_test_jsonata_transform',
    name: '🧪 Test: JSONata Transform',
    description: 'Trigger manual con array di oggetti → trasforma con JSONata (somma revenue, conta righe).',
    category: 'data-pipeline',
    tags: ['test', 'jsonata', 'transform'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 3,
    requiredIntegrations: ['trigger_manual', 'logic_transform'],
    nodes: [
      { id: 'start', defId: 'trigger_manual', x: 0, y: 0, config: {} },
      { id: 'xform', defId: 'logic_transform', x: 220, y: 0, config: { expression: '{ "totalRevenue": $sum(input.rows.revenue), "count": $count(input.rows) }' } },
    ],
    edges: [{ from: 'start', to: 'xform' }],
  },
  {
    id: 'tmpl_test_ai_agents_parallel',
    name: '🧪 Test: 3 AI Agents (translator + classifier + extractor)',
    description: 'Manual trigger con un testo italiano → traduce in EN, classifica sentiment, estrae entità nominate.',
    category: 'ai-orchestration',
    tags: ['test', 'AI', 'liara'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 10,
    requiredIntegrations: ['trigger_manual', 'agent_translator', 'agent_classifier', 'agent_extractor'],
    nodes: [
      { id: 'start', defId: 'trigger_manual', x: 0, y: 0, config: {} },
      { id: 'translate', defId: 'agent_translator', x: 220, y: 0, config: { provider: '', extraContext: 'Translate from Italian to English.' } },
      { id: 'classify', defId: 'agent_classifier', x: 220, y: 120, config: { provider: '' } },
      { id: 'extract', defId: 'agent_extractor', x: 220, y: 240, config: { provider: '' } },
    ],
    edges: [
      { from: 'start', to: 'translate' },
      { from: 'start', to: 'classify' },
      { from: 'start', to: 'extract' },
    ],
  },
  {
    id: 'tmpl_test_form_to_db',
    name: '🧪 Test: Form pubblico → Database',
    description: 'Form HTML auto-generato (nome+email+messaggio) → AI extract → salva in tabella contatti.',
    category: 'crm',
    tags: ['test', 'form', 'lead'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 5,
    requiredIntegrations: ['trigger_form', 'db_insert'],
    nodes: [
      { id: 'form', defId: 'trigger_form', x: 0, y: 0, config: { title: 'Contattaci', fieldsJson: '[{"key":"name","label":"Nome","type":"text","required":true},{"key":"email","label":"Email","type":"email","required":true},{"key":"message","label":"Messaggio","type":"textarea","required":true}]', submitLabel: 'Invia' } },
      { id: 'ins', defId: 'db_insert', x: 220, y: 0, config: { rowJson: '{"name":"{{form.output.body.name}}","email":"{{form.output.body.email}}","message":"{{form.output.body.message}}"}' } },
    ],
    edges: [{ from: 'form', to: 'ins' }],
  },
  {
    id: 'tmpl_test_db_change_log',
    name: '🧪 Test: DB Change trigger',
    description: 'Quando viene inserita una riga in metrics → AI riassume e logga su file.',
    category: 'monitoring',
    tags: ['test', 'db', 'realtime'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 5,
    requiredIntegrations: ['trigger_db_change', 'agent_summarizer', 'action_file_write'],
    nodes: [
      { id: 'sub', defId: 'trigger_db_change', x: 0, y: 0, config: { ops: 'insert', pollIntervalSec: '5' } },
      { id: 'sum', defId: 'agent_summarizer', x: 220, y: 0, config: {} },
      { id: 'log', defId: 'action_file_write', x: 440, y: 0, config: { path: 'logs/db-changes.log', mode: 'append' } },
    ],
    edges: [{ from: 'sub', to: 'sum' }, { from: 'sum', to: 'log' }],
  },
  {
    id: 'tmpl_test_file_watch',
    name: '🧪 Test: File Watch trigger',
    description: 'Monitora /tmp/flowforge-watch/ → quando arriva un file, lo legge e logga il contenuto.',
    category: 'general',
    tags: ['test', 'file-watch'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 5,
    requiredIntegrations: ['trigger_file_watch', 'action_file_read'],
    nodes: [
      { id: 'watch', defId: 'trigger_file_watch', x: 0, y: 0, config: { directory: 'watch', events: 'add', debounceMs: '500' } },
      { id: 'read', defId: 'action_file_read', x: 220, y: 0, config: { path: '{{watch.output.path}}' } },
    ],
    edges: [{ from: 'watch', to: 'read' }],
  },
  {
    id: 'tmpl_test_ai_tool_loop',
    name: '🧪 Test: AI Agent autonomo con tool calling',
    description: 'Agente Liara con accesso a rag_search e db_query — fa Q&A iterativo sul tuo DB e knowledge base.',
    category: 'ai-orchestration',
    tags: ['test', 'AI', 'tool-calling', 'agentic'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'advanced',
    estimatedSetupMin: 15,
    requiredIntegrations: ['trigger_manual', 'ai_agent_tool_loop'],
    nodes: [
      { id: 'start', defId: 'trigger_manual', x: 0, y: 0, config: {} },
      { id: 'agent', defId: 'ai_agent_tool_loop', x: 220, y: 0, config: { provider: '', maxIterations: '5' } },
    ],
    edges: [{ from: 'start', to: 'agent' }],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // TIER 2 — TEMPLATES BUSINESS (workflow reali per aziende italiane)
  // ═══════════════════════════════════════════════════════════════════════

  {
    id: 'tmpl_biz_order_from_email',
    name: '📧 Ordine fornitore via email → DB',
    description: "Quando arriva un'email da un fornitore con conferma ordine, AI estrae prodotti/quantità/prezzi e inserisce nella tabella ordini. Salva anche l'email originale per audit.",
    category: 'data-pipeline',
    tags: ['email', 'ordini', 'fornitori', 'AI', 'business'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 20,
    requiredIntegrations: ['trigger_imap', 'agent_extractor', 'logic_if', 'db_insert', 'action_file_write'],
    nodes: [
      { id: 'inbox', defId: 'trigger_imap', x: 0, y: 0, config: { host: 'imap.gmail.com', port: '993', mailbox: 'INBOX', pollIntervalSec: '60', filterSubject: '(ordine|conferma|order)' } },
      { id: 'is_supplier', defId: 'logic_if', x: 220, y: 0, config: { condition: '/fornitore|supplier|orders@/i.test(input.from)' } },
      { id: 'extract', defId: 'agent_extractor', x: 440, y: 0, config: { provider: '', extraContext: 'Estrai dall\'email: lista prodotti (nome, codice SKU, quantità, prezzo_unitario), totale, data consegna prevista, numero ordine. Restituisci JSON con campi: order_number, supplier_email, total, expected_delivery, items[].' } },
      { id: 'save_order', defId: 'db_insert', x: 660, y: 0, config: { table: 'orders', rowJson: '{"order_number":"{{extract.output.order_number}}","supplier_email":"{{inbox.output.from}}","total":{{extract.output.total}},"expected_delivery":"{{extract.output.expected_delivery}}","items_json":"{{extract.output.items}}","received_at":"{{inbox.output.date}}","raw_subject":"{{inbox.output.subject}}"}' } },
      { id: 'archive', defId: 'action_file_write', x: 660, y: 140, config: { path: 'archive/orders/{{extract.output.order_number}}.eml', content: '{{inbox.output.raw}}', mode: 'overwrite' } },
    ],
    edges: [
      { from: 'inbox', to: 'is_supplier' },
      { from: 'is_supplier', to: 'extract', fromPort: 'true' },
      { from: 'extract', to: 'save_order' },
      { from: 'extract', to: 'archive' },
    ],
  },
  {
    id: 'tmpl_biz_lead_qualifier',
    name: '🎯 Lead qualifier — Form contatti → CRM + alert',
    description: 'Form pubblico sul tuo sito (nome, email, azienda, messaggio) → AI qualifica il lead (hot/warm/cold) + estrae industry + size → inserisce nel DB + alert Slack se HOT.',
    category: 'crm',
    tags: ['lead', 'CRM', 'form', 'AI', 'slack'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 15,
    requiredIntegrations: ['trigger_form', 'agent_classifier', 'db_insert', 'logic_if', 'community_slack'],
    nodes: [
      { id: 'form', defId: 'trigger_form', x: 0, y: 0, config: { title: 'Contattaci', fieldsJson: '[{"key":"name","label":"Nome e cognome","type":"text","required":true},{"key":"email","label":"Email aziendale","type":"email","required":true},{"key":"company","label":"Azienda","type":"text","required":true},{"key":"role","label":"Ruolo","type":"text"},{"key":"company_size","label":"Dimensione azienda","type":"select","options":["1-10","11-50","51-200","201-1000","1000+"]},{"key":"message","label":"Come possiamo aiutarti?","type":"textarea","required":true}]', submitLabel: 'Invia richiesta' } },
      { id: 'qualify', defId: 'agent_classifier', x: 220, y: 0, config: { provider: '', extraContext: 'Classifica il lead: hot (vuole comprare entro 30gg), warm (interessato, 1-3 mesi), cold (esplora). Output JSON: {level, reasoning, industry, urgency_score}.' } },
      { id: 'save', defId: 'db_insert', x: 440, y: 0, config: { table: 'leads', rowJson: '{"name":"{{form.output.body.name}}","email":"{{form.output.body.email}}","company":"{{form.output.body.company}}","role":"{{form.output.body.role}}","company_size":"{{form.output.body.company_size}}","message":"{{form.output.body.message}}","level":"{{qualify.output.level}}","industry":"{{qualify.output.industry}}","urgency":{{qualify.output.urgency_score}}}' } },
      { id: 'is_hot', defId: 'logic_if', x: 660, y: 0, config: { condition: 'input.level === "hot"' } },
      { id: 'alert', defId: 'community_slack', x: 880, y: 0, config: { action: 'send_message', channel: '#sales', text: '🔥 HOT LEAD: {{form.output.body.name}} da {{form.output.body.company}} ({{form.output.body.company_size}}) — {{qualify.output.reasoning}}' } },
    ],
    edges: [
      { from: 'form', to: 'qualify' },
      { from: 'qualify', to: 'save' },
      { from: 'save', to: 'is_hot' },
      { from: 'is_hot', to: 'alert', fromPort: 'true' },
    ],
  },
  {
    id: 'tmpl_biz_invoice_to_fatture',
    name: '💰 Webhook ordine → Fattura su Fatture in Cloud',
    description: "Quando ricevi un webhook con dati ordine cliente (es. da Shopify/WooCommerce/sito custom), crea o trova il cliente su Fatture in Cloud, emette fattura, invia PEC di conferma al cliente.",
    category: 'fiscalita-italia',
    tags: ['fattura', 'fatture-in-cloud', 'shopify', 'PEC'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 25,
    requiredIntegrations: ['trigger_webhook', 'italia_fatture_in_cloud_client', 'italia_fatture_in_cloud_invoice', 'italia_pec_aruba_send'],
    nodes: [
      { id: 'wh', defId: 'trigger_webhook', x: 0, y: 0, config: { method: 'POST' } },
      { id: 'client', defId: 'italia_fatture_in_cloud_client', x: 220, y: 0, config: { createIfMissing: 'true' } },
      { id: 'invoice', defId: 'italia_fatture_in_cloud_invoice', x: 440, y: 0, config: {} },
      { id: 'notify', defId: 'italia_pec_aruba_send', x: 660, y: 0, config: { subject: 'La tua fattura {{invoice.output.invoice_number}}' } },
    ],
    edges: [
      { from: 'wh', to: 'client' },
      { from: 'client', to: 'invoice' },
      { from: 'invoice', to: 'notify' },
    ],
  },
  {
    id: 'tmpl_biz_pec_archive',
    name: '📥 Archivio PEC ricevute',
    description: 'Quando arriva una PEC, AI classifica (fattura/contratto/comunicazione legale/altro), salva il PDF allegato in archivio strutturato + log nel DB per audit GDPR.',
    category: 'fiscalita-italia',
    tags: ['PEC', 'archivio', 'GDPR', 'AI'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 15,
    requiredIntegrations: ['italia_pec_aruba_receive', 'agent_classifier', 'action_file_write', 'db_insert'],
    nodes: [
      { id: 'pec', defId: 'italia_pec_aruba_receive', x: 0, y: 0, config: { pollIntervalSec: '120' } },
      { id: 'classify', defId: 'agent_classifier', x: 220, y: 0, config: { provider: '', extraContext: 'Classifica: fattura | contratto | comunicazione_legale | altro. Output JSON: {category, sender_type, urgency}.' } },
      { id: 'archive', defId: 'action_file_write', x: 440, y: 0, config: { path: 'archive/pec/{{classify.output.category}}/{{pec.output.message_id}}.eml', mode: 'overwrite' } },
      { id: 'log', defId: 'db_insert', x: 440, y: 140, config: { table: 'pec_audit', rowJson: '{"message_id":"{{pec.output.message_id}}","from":"{{pec.output.from}}","subject":"{{pec.output.subject}}","category":"{{classify.output.category}}","urgency":"{{classify.output.urgency}}","received_at":"{{pec.output.date}}"}' } },
    ],
    edges: [
      { from: 'pec', to: 'classify' },
      { from: 'classify', to: 'archive' },
      { from: 'classify', to: 'log' },
    ],
  },
  {
    id: 'tmpl_biz_sales_dashboard_daily',
    name: '📊 Report vendite giornaliero via email',
    description: 'Ogni mattina alle 8, query del DB ordini di ieri, AI genera insight (top prodotti, anomalie, trend), invia email HTML al management.',
    category: 'monitoring',
    tags: ['report', 'cron', 'vendite', 'email'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 10,
    requiredIntegrations: ['trigger_cron', 'db_query', 'agent_data_analyst', 'action_send_email'],
    nodes: [
      { id: 'cron', defId: 'trigger_cron', x: 0, y: 0, config: { cronExpression: '0 8 * * 1-5', timezone: 'Europe/Rome' } },
      { id: 'q', defId: 'db_query', x: 220, y: 0, config: { table: 'orders' } },
      { id: 'analyze', defId: 'agent_data_analyst', x: 440, y: 0, config: { provider: '', extraContext: 'Genera report vendite: totale, top 3 prodotti, top 3 clienti, eventuali anomalie. Italiano, professionale. Output HTML.' } },
      { id: 'email', defId: 'action_send_email', x: 660, y: 0, config: { to: 'management@example.com', subject: 'Report vendite — {{cron.output.timestamp}}', body: '{{analyze.output.report}}' } },
    ],
    edges: [{ from: 'cron', to: 'q' }, { from: 'q', to: 'analyze' }, { from: 'analyze', to: 'email' }],
  },
  {
    id: 'tmpl_biz_customer_followup',
    name: '🤝 Customer follow-up post-acquisto',
    description: 'Webhook ordine completato → attendi 7 giorni (delay) → AI genera email personalizzata di follow-up basata sul prodotto comprato → invia SMTP.',
    category: 'crm',
    tags: ['customer-success', 'email', 'AI', 'follow-up'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 10,
    requiredIntegrations: ['trigger_webhook', 'logic_delay', 'agent_summarizer', 'action_send_email'],
    nodes: [
      { id: 'wh', defId: 'trigger_webhook', x: 0, y: 0, config: { method: 'POST' } },
      { id: 'wait', defId: 'logic_delay', x: 220, y: 0, config: { durationMs: '604800000' } },
      { id: 'compose', defId: 'agent_summarizer', x: 440, y: 0, config: { provider: '', extraContext: 'Componi email di follow-up personale (italiano, tono amichevole) per cliente {{wh.output.body.customer_name}} che ha comprato {{wh.output.body.product}}. Chiedi feedback + offri sconto 10%.' } },
      { id: 'send', defId: 'action_send_email', x: 660, y: 0, config: { to: '{{wh.output.body.customer_email}}', subject: 'Come va con {{wh.output.body.product}}?', body: '{{compose.output.detailed}}' } },
    ],
    edges: [{ from: 'wh', to: 'wait' }, { from: 'wait', to: 'compose' }, { from: 'compose', to: 'send' }],
  },
  {
    id: 'tmpl_biz_backup_daily',
    name: '💾 Backup giornaliero DB',
    description: 'Ogni notte alle 3, esporta tutta la tabella ordini in JSON, salva su disco con timestamp + log Slack.',
    category: 'devops',
    tags: ['backup', 'cron', 'database'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'beginner',
    estimatedSetupMin: 8,
    requiredIntegrations: ['trigger_cron', 'db_query', 'action_file_write', 'community_slack'],
    nodes: [
      { id: 'cron', defId: 'trigger_cron', x: 0, y: 0, config: { cronExpression: '0 3 * * *', timezone: 'Europe/Rome' } },
      { id: 'dump', defId: 'db_query', x: 220, y: 0, config: {} },
      { id: 'save', defId: 'action_file_write', x: 440, y: 0, config: { path: 'backup/db-{{cron.output.timestamp}}.json', content: '{{dump.output}}', mode: 'overwrite' } },
      { id: 'notify', defId: 'community_slack', x: 660, y: 0, config: { action: 'send_message', channel: '#devops', text: '✅ Backup {{dump.output.rowCount}} righe completato' } },
    ],
    edges: [{ from: 'cron', to: 'dump' }, { from: 'dump', to: 'save' }, { from: 'save', to: 'notify' }],
  },
  {
    id: 'tmpl_biz_github_issue_triage',
    name: '🐛 GitHub issue → AI triage + Linear',
    description: 'Webhook da GitHub quando viene aperta una issue → AI determina priorità (P0/P1/P2) e team owner → crea task corrispondente su Linear.',
    category: 'devops',
    tags: ['github', 'linear', 'triage', 'AI'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 12,
    requiredIntegrations: ['trigger_webhook', 'agent_classifier', 'community_linear'],
    nodes: [
      { id: 'wh', defId: 'trigger_webhook', x: 0, y: 0, config: { method: 'POST' } },
      { id: 'triage', defId: 'agent_classifier', x: 220, y: 0, config: { provider: '', extraContext: 'Classifica issue GitHub: priority (P0=critico/P1=alto/P2=medio/P3=basso), team (frontend/backend/infra/security), estimated_hours. Output JSON.' } },
      { id: 'linear', defId: 'community_linear', x: 440, y: 0, config: { action: 'create_issue', title: '[{{triage.output.priority}}] {{wh.output.body.issue.title}}', description: '{{wh.output.body.issue.body}}\n\n📊 AI triage: {{triage.output.team}} · est. {{triage.output.estimated_hours}}h\n🔗 GitHub: {{wh.output.body.issue.html_url}}' } },
    ],
    edges: [{ from: 'wh', to: 'triage' }, { from: 'triage', to: 'linear' }],
  },

  // ─── Sprint 2026-06-06 E2: 6 template enterprise top-richiesta ─────────
  {
    id: 'tmpl_biz_lead_scoring_batch',
    name: '🎯 Lead scoring batch + CRM sync',
    description: 'Cron giornaliero alle 8: pesca lead nuovi da Odoo, calcola lead score (intent + budget + fit), aggiorna scheda CRM, notifica account manager se score≥80.',
    category: 'crm',
    tags: ['lead-scoring', 'odoo', 'CRM', 'AI', 'cron'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 20,
    requiredIntegrations: ['trigger_cron', 'action_odoo_rpc', 'action_lead_score', 'logic_if', 'integration_slack_post'],
    nodes: [
      { id: 'cron', defId: 'trigger_cron', x: 0, y: 0, config: { cronExpression: '0 8 * * *', timezone: 'Europe/Rome' } },
      { id: 'fetch', defId: 'action_odoo_rpc', x: 220, y: 0, config: { model: 'crm.lead', operation: 'search_read', domainJson: '[["stage_id.is_won","=",false],["create_date",">=","{{cron.output.dayMinus1}}"]]' } },
      { id: 'score', defId: 'action_lead_score', x: 440, y: 0, config: {} },
      { id: 'gate', defId: 'logic_if', x: 660, y: 0, config: { expression: '{{score.output.score}} >= 80' } },
      { id: 'alert', defId: 'integration_slack_post', x: 880, y: -60, config: { channel: '#sales-hot', text: '🔥 Hot lead {{fetch.output.name}} — score {{score.output.score}}/100' } },
    ],
    edges: [
      { from: 'cron', to: 'fetch' },
      { from: 'fetch', to: 'score' },
      { from: 'score', to: 'gate' },
      { from: 'gate', to: 'alert', sourceHandle: 'true' },
    ],
  },
  {
    id: 'tmpl_biz_kpi_dashboard_telegram',
    name: '📊 KPI report giornaliero su Telegram',
    description: 'Ogni mattina alle 7, calcola KPI business (fatturato, nuovi clienti, churn) interrogando il DB, formatta il report in Markdown e lo invia al canale Telegram del management.',
    category: 'monitoring',
    tags: ['KPI', 'dashboard', 'telegram', 'cron', 'report'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 15,
    requiredIntegrations: ['trigger_cron', 'db_query', 'action_text_template', 'integration_telegram_send'],
    nodes: [
      { id: 'cron', defId: 'trigger_cron', x: 0, y: 0, config: { cronExpression: '0 7 * * *', timezone: 'Europe/Rome' } },
      { id: 'kpi', defId: 'db_query', x: 220, y: 0, config: { sql: 'SELECT COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL \'1 day\') AS new_customers, SUM(amount) FILTER (WHERE date = CURRENT_DATE) AS revenue_today FROM orders' } },
      { id: 'fmt', defId: 'action_text_template', x: 440, y: 0, config: { template: '📊 *KPI {{cron.output.dateIt}}*\n\n💰 Fatturato: €{{kpi.output.rows[0].revenue_today}}\n👥 Nuovi clienti: {{kpi.output.rows[0].new_customers}}\n\n_Generato automaticamente_' } },
      { id: 'tg', defId: 'integration_telegram_send', x: 660, y: 0, config: { parseMode: 'Markdown' } },
    ],
    edges: [{ from: 'cron', to: 'kpi' }, { from: 'kpi', to: 'fmt' }, { from: 'fmt', to: 'tg' }],
  },
  {
    id: 'tmpl_biz_scraping_price_monitor',
    name: '💸 Price monitor competitor → alert',
    description: 'Ogni 6 ore controlla 20 URL di prodotti competitor, estrae prezzo via CSS selector, confronta con storico in DB. Se variazione >10% manda alert email al product manager.',
    category: 'monitoring',
    tags: ['scraping', 'competitor', 'price', 'monitoring', 'alert'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'advanced',
    estimatedSetupMin: 25,
    requiredIntegrations: ['trigger_cron', 'logic_loop', 'web_fetch_advanced', 'html_select', 'logic_if', 'action_send_email'],
    nodes: [
      { id: 'cron', defId: 'trigger_cron', x: 0, y: 0, config: { cronExpression: '0 */6 * * *', timezone: 'Europe/Rome' } },
      { id: 'loop', defId: 'logic_loop', x: 220, y: 0, config: { itemsExpression: '["https://competitor1.com/p/foo","https://competitor2.com/p/bar"]', strategy: 'naive', concurrency: '2', rateLimitPerMin: '60' } },
      { id: 'fetch', defId: 'web_fetch_advanced', x: 440, y: 0, config: { url: '{{loop.item}}', method: 'GET', userAgent: 'rotate' } },
      { id: 'price', defId: 'html_select', x: 660, y: 0, config: { selector: '.price, [itemprop="price"]', attribute: 'textContent' } },
      { id: 'diff', defId: 'logic_if', x: 880, y: 0, config: { expression: 'Math.abs({{price.output.value}} - {{previous}}) / {{previous}} > 0.1' } },
      { id: 'alert', defId: 'action_send_email', x: 1100, y: -60, config: { to: 'pm@zeli.it', subject: '🚨 Price change su {{loop.item}}', body: 'Vecchio: {{previous}}\nNuovo: {{price.output.value}}' } },
    ],
    edges: [
      { from: 'cron', to: 'loop' },
      { from: 'loop', to: 'fetch', sourceHandle: 'body' },
      { from: 'fetch', to: 'price' },
      { from: 'price', to: 'diff' },
      { from: 'diff', to: 'alert', sourceHandle: 'true' },
    ],
  },
  {
    id: 'tmpl_biz_gdpr_export_request',
    name: '🔐 GDPR data export request',
    description: 'Webhook da modulo "Esporta i miei dati" (art. 20 GDPR): query tutti i record collegati alla email, costruisce ZIP firmato HMAC e invia link download protetto.',
    category: 'general',
    tags: ['GDPR', 'art-20', 'data-portability', 'compliance', 'EU'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'advanced',
    estimatedSetupMin: 20,
    requiredIntegrations: ['trigger_webhook', 'db_query', 'action_text_template', 'action_file_write', 'action_send_email'],
    nodes: [
      { id: 'wh', defId: 'trigger_webhook', x: 0, y: 0, config: { method: 'POST', authMode: 'hmac-signature' } },
      { id: 'pull', defId: 'db_query', x: 220, y: 0, config: { sql: 'SELECT row_to_json(t) FROM (SELECT * FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE u.email = $1) t', params: '["{{wh.output.body.email}}"]' } },
      { id: 'fmt', defId: 'action_text_template', x: 440, y: 0, config: { template: '{{ JSON.stringify(pull.output.rows, null, 2) }}' } },
      { id: 'save', defId: 'action_file_write', x: 660, y: 0, config: { path: 'gdpr-exports/{{wh.output.body.email}}/{{wh.output.timestamp}}.json', content: '{{fmt.output}}', mode: 'overwrite' } },
      { id: 'mail', defId: 'action_send_email', x: 880, y: 0, config: { to: '{{wh.output.body.email}}', subject: 'I tuoi dati (GDPR art. 20)', body: 'Trovi il download protetto qui: {{save.output.signedUrl}}\n\nIl link scade dopo 7 giorni come da policy.' } },
    ],
    edges: [{ from: 'wh', to: 'pull' }, { from: 'pull', to: 'fmt' }, { from: 'fmt', to: 'save' }, { from: 'save', to: 'mail' }],
  },
  {
    id: 'tmpl_ai_meeting_transcript_action_items',
    name: '🎤 Trascrizione meeting → action items',
    description: 'Webhook da Zoom/Teams quando termina una call, scarica audio MP3, lo passa al summarizer AI per estrarre decisioni + action items, crea task in Linear assegnati per owner.',
    category: 'ai-orchestration',
    tags: ['meeting', 'transcription', 'AI', 'action-items', 'linear'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'advanced',
    estimatedSetupMin: 18,
    requiredIntegrations: ['trigger_webhook', 'action_video_summarizer', 'logic_loop', 'integration_linear_create_issue'],
    nodes: [
      { id: 'wh', defId: 'trigger_webhook', x: 0, y: 0, config: { method: 'POST', authMode: 'hmac-signature' } },
      { id: 'sum', defId: 'action_video_summarizer', x: 220, y: 0, config: { url: '{{wh.output.body.recording_url}}', transcribeWithWhisper: 'false', extractActionItems: 'true' } },
      { id: 'loop', defId: 'logic_loop', x: 440, y: 0, config: { itemsExpression: '{{sum.output.actionItems}}', strategy: 'naive', concurrency: '3' } },
      { id: 'task', defId: 'integration_linear_create_issue', x: 660, y: 0, config: { title: '{{loop.item.title}}', description: '{{loop.item.context}}\n\nMeeting: {{wh.output.body.title}}\nOwner: {{loop.item.owner}}', team: '{{loop.item.team}}' } },
    ],
    edges: [{ from: 'wh', to: 'sum' }, { from: 'sum', to: 'loop' }, { from: 'loop', to: 'task', sourceHandle: 'body' }],
  },
  {
    id: 'tmpl_biz_stripe_dunning_recovery',
    name: '💳 Stripe dunning recovery + cancellation prevention',
    description: 'Webhook quando un pagamento Stripe fallisce: retry automatico con backoff, AI compone email personalizzata per il cliente, se non risponde in 5 giorni triggera workflow di churn save (sconto + call).',
    category: 'crm',
    tags: ['stripe', 'dunning', 'churn', 'AI', 'recovery'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'advanced',
    estimatedSetupMin: 22,
    requiredIntegrations: ['trigger_webhook', 'logic_delay', 'action_http', 'action_email_personalize', 'logic_if', 'action_send_email'],
    nodes: [
      { id: 'wh', defId: 'trigger_webhook', x: 0, y: 0, config: { method: 'POST', authMode: 'hmac-signature' } },
      { id: 'wait1', defId: 'logic_delay', x: 220, y: 0, config: { durationMs: '86400000' } },
      { id: 'retry', defId: 'action_http', x: 440, y: 0, config: { url: 'https://api.stripe.com/v1/charges/{{wh.output.body.charge_id}}/capture', method: 'POST' } },
      { id: 'gate', defId: 'logic_if', x: 660, y: 0, config: { expression: '{{retry.output.status}} === "succeeded"' } },
      { id: 'compose', defId: 'action_email_personalize', x: 880, y: 60, config: { tone: 'empathetic', context: 'Cliente {{wh.output.body.customer.name}} ha pagamento fallito su Stripe. Offri sconto 20% + opzione metodo pagamento alternativo.' } },
      { id: 'send', defId: 'action_send_email', x: 1100, y: 60, config: { to: '{{wh.output.body.customer.email}}', subject: 'Possiamo aiutarti con il pagamento?', body: '{{compose.output.body}}' } },
    ],
    edges: [
      { from: 'wh', to: 'wait1' },
      { from: 'wait1', to: 'retry' },
      { from: 'retry', to: 'gate' },
      { from: 'gate', to: 'compose', sourceHandle: 'false' },
      { from: 'compose', to: 'send' },
    ],
  },

  // ─── Lead generation commerciale B2B (autonomo) ─────────────────────
  // ⚠️ Sintassi espressioni: $node.<id>.json.* (NON <id>.output.*). Nessun
  // dato sensibile: casella email da configurare, prodotto da personalizzare.
  {
    id: 'tmpl_lead_gen_b2b',
    name: '📧 Lead generation commerciale B2B (autonomo)',
    description:
      'Motore di prospecting autonomo: ogni giorno feriale cerca aziende del tuo target, estrae l\'email '
      + 'aziendale dal loro sito, la valida, qualifica il lead, scrive con l\'AI un\'email personalizzata e la '
      + 'invia — con dedup (non ricontatta chi hai già scritto) e rispetto dell\'opt-out (chi risponde STOP non '
      + 'viene più contattato). Ricerca via SearXNG interno, nessuna API key esterna.\n\n'
      + 'DA PERSONALIZZARE dopo l\'installazione (tutti campi vuoti/placeholder, nessun dato reale):\n'
      + '1) Nodo "Cerca aziende" → descrivi il TUO cliente target (es. "studi dentistici in Lombardia").\n'
      + '2) Nodo "Scrivi email (AI)" → nel prompt di sistema sostituisci [LA TUA AZIENDA] e [IL TUO PRODOTTO].\n'
      + '3) Nodo "Invia email" → host/porta/username SMTP + mittente; la password va come secret SMTP_PASSWORD '
      + '(Settings → Credentials), MAI in chiaro. Imposta "Rispondi a" col tuo indirizzo.\n'
      + '4) Nodo "Qualifica lead" → adatta le keyword positive/negative al tuo settore.\n'
      + '5) Installa ANCHE il template "Gestione opt-out" e abilita SPF/DKIM del tuo dominio prima di attivare.\n\n'
      + 'Tabelle create automaticamente: lead_contatti (anti-duplicato) e opt_out (disiscritti). Opt-out "STOP" '
      + 'incluso in ogni email (GDPR B2B). Volume iniziale prudente: 10 contatti/giorno.',
    category: 'crm',
    tags: ['lead-gen', 'outreach', 'commerciale', 'b2b', 'ai', 'email', 'autonomo'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'advanced',
    estimatedSetupMin: 25,
    featured: true,
    requiredIntegrations: ['trigger_cron', 'action_company_search', 'logic_loop', 'action_contact_discovery', 'action_email_validate_mx', 'action_lead_score', 'db_query', 'logic_if', 'action_llm_complete', 'action_send_email', 'db_insert'],
    nodes: [
      { id: 'trigger', defId: 'trigger_cron', x: 40, y: 340, config: { cronExpression: '0 10 * * 1-5', timezone: 'Europe/Rome' } },
      { id: 'cerca', defId: 'action_company_search', x: 280, y: 340, config: {
        seedPrompt: 'PERSONALIZZA: descrivi qui il tuo cliente target, es. "ristoranti e cocktail bar di fascia alta in Italia"',
        country: 'IT', maxResults: '10', resultsPerQuery: '10', queryExpansionCount: '6',
      } },
      { id: 'loop', defId: 'logic_loop', x: 520, y: 340, config: {
        itemsExpression: 'input.companies', strategy: 'naive', batchSize: '1', concurrency: '1',
        errorPolicy: 'continue', rateLimitPerMin: '10', maxItems: '10', aggregateReducer: 'count',
      } },
      { id: 'contatti', defId: 'action_contact_discovery', x: 760, y: 340, config: {
        homeUrl: '{{ item.url }}', maxPages: '6', respectRobots: 'true', followSitemap: 'true',
        preferredLocalParts: 'info,commerciale,prenotazioni,booking,contatti,sales', minEmailConfidence: '0.5',
      } },
      { id: 'valida', defId: 'action_email_validate_mx', x: 1000, y: 340, config: {
        email: '{{ $node.contatti.json.primary_email }}', minConfidence: '0.5',
      } },
      { id: 'score', defId: 'action_lead_score', x: 1240, y: 340, config: {
        content: '{{ (item.title || "") + " " + (item.snippet || "") + " " + (item.url || "") }}',
        country: 'IT', profile: 'custom', threshold: '20',
        customPositiveJson: '[{"keyword":"PERSONALIZZA-settore","weight":30},{"keyword":"contatti","weight":10}]',
        customNegativeJson: '[{"keyword":"magazine","weight":90},{"keyword":"rivista","weight":90},{"keyword":"wikipedia","weight":100},{"keyword":"classifica","weight":40}]',
      } },
      { id: 'dedup', defId: 'db_query', x: 1480, y: 340, config: {
        databaseId: 'crm_db', table: 'lead_contatti', limit: '1',
        filtersJson: '[{"column":"email","op":"eq","value":"{{ $node.contatti.json.primary_email }}"}]',
      } },
      { id: 'optout', defId: 'db_query', x: 1720, y: 340, config: {
        databaseId: 'crm_db', table: 'opt_out', limit: '1',
        filtersJson: '[{"column":"email","op":"eq","value":"{{ $node.contatti.json.primary_email }}"}]',
      } },
      { id: 'gate', defId: 'logic_if', x: 1960, y: 340, config: {
        condition: '$node.contatti.json.has_emails === true && $node.valida.json.mx_valid === true && $node.score.json.send_recommended === true && $node.dedup.json.rowCount === 0 && $node.optout.json.rowCount === 0',
      } },
      { id: 'scrivi', defId: 'action_llm_complete', x: 2200, y: 220, config: {
        provider: 'liara', responseFormat: 'json', temperature: '0.55', maxTokens: '400',
        systemPrompt: 'Sei un copywriter commerciale B2B per [LA TUA AZIENDA], che offre [IL TUO PRODOTTO/SERVIZIO]. Ricevi i dati di un\'azienda target e scrivi SOLO l\'apertura di una email di proposta. Rispondi SOLO con JSON valido: {"oggetto":"...","apertura_html":"..."}. REGOLE: apertura_html = 2 brevi <p> (max 55 parole), personalizzati sul destinatario; NON inventare numeri/prezzi/dati; tono professionale ed elegante, italiano; oggetto max 8 parole.',
        prompt: 'AZIENDA: {{ item.title }}\nSITO: {{ item.url }}\nDESCRIZIONE: {{ item.snippet }}',
      } },
      { id: 'invia', defId: 'action_send_email', x: 2440, y: 220, config: {
        systemAccountId: '', host: '', port: '587', security: 'starttls', authMode: 'password',
        username: '', password: '{{ secrets.SMTP_PASSWORD }}', from: '', replyTo: '',
        to: '{{ $node.contatti.json.primary_email }}',
        subject: '{{ ($node.scrivi.json.jsonParsed || {}).oggetto || ("Proposta commerciale per " + item.title) }}',
        bodyType: 'html',
        body: '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#2b2b2b">'
          + '<div style="background:#1c1a12;color:#e9dcc0;padding:22px;text-align:center;font-size:22px;letter-spacing:2px">IL TUO BRAND</div>'
          + '<div style="padding:24px 28px;font-size:15px;line-height:1.6">'
          + '{{ ($node.scrivi.json.jsonParsed || {}).apertura_html || "<p>Vi scriviamo per proporvi i nostri prodotti.</p>" }}'
          + '<p style="text-align:center;margin:26px 0"><a href="mailto:PERSONALIZZA@tua-azienda.it" style="background:#b08d57;color:#1c1a12;text-decoration:none;font-weight:bold;padding:12px 26px;border-radius:6px">Scopri di più</a></p></div>'
          + '<div style="background:#f2efe8;padding:16px 28px;font-size:12px;color:#777">La Tua Azienda SRL · Indirizzo · tua@email.it<br>'
          + 'Se non desidera ricevere altre comunicazioni, risponda con STOP e non la contatteremo più.</div></div>',
        deliverabilityCheck: 'off',
      } },
      { id: 'registra', defId: 'db_insert', x: 2680, y: 220, config: {
        databaseId: 'crm_db', table: 'lead_contatti', onConflict: 'ignore',
        rowJson: '{"azienda":{{ JSON.stringify(item.title || "") }},"url":{{ JSON.stringify(item.url || "") }},"email":{{ JSON.stringify($node.contatti.json.primary_email || "") }},"score":{{ $node.score.json.score || 0 }},"oggetto":{{ JSON.stringify(($node.scrivi.json.jsonParsed || {}).oggetto || "") }}}',
      } },
    ],
    edges: [
      { from: 'trigger', to: 'cerca' }, { from: 'cerca', to: 'loop' }, { from: 'loop', to: 'contatti' },
      { from: 'contatti', to: 'valida' }, { from: 'valida', to: 'score' }, { from: 'score', to: 'dedup' },
      { from: 'dedup', to: 'optout' }, { from: 'optout', to: 'gate' }, { from: 'gate', to: 'scrivi', fromPort: 'true' },
      { from: 'scrivi', to: 'invia' }, { from: 'invia', to: 'registra' },
    ],
    tablesToCreate: [
      {
        databaseId: 'crm_db', name: 'lead_contatti',
        description: 'Aziende già contattate (anti-duplicato su email).',
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'azienda', type: 'text' },
          { name: 'url', type: 'text' },
          { name: 'email', type: 'text', unique: true },
          { name: 'score', type: 'integer' },
          { name: 'oggetto', type: 'text' },
          { name: 'contattato_il', type: 'datetime' },
        ],
      },
      {
        databaseId: 'crm_db', name: 'opt_out',
        description: 'Email che hanno risposto STOP — mai ricontattare (GDPR).',
        columns: [
          { name: 'email', type: 'text', primaryKey: true, nullable: false },
          { name: 'motivo', type: 'text' },
          { name: 'creato_il', type: 'datetime' },
        ],
      },
    ],
  },

  // ─── Gestione opt-out email (STOP) — companion del lead-gen ─────────
  {
    id: 'tmpl_email_optout_handler',
    name: '🛑 Gestione opt-out email (STOP)',
    description:
      'Companion GDPR del template "Lead generation B2B": controlla la casella email da cui invii; quando '
      + 'qualcuno risponde STOP, registra il mittente nella tabella opt_out — così il motore di prospecting '
      + 'non lo ricontatta più. Autonomo (controlla la posta ogni 5 minuti).\n\n'
      + 'DA CONFIGURARE: nodo "Email in arrivo (IMAP)" → host IMAP, porta 993, username della stessa casella da '
      + 'cui invii; la password come secret SMTP_PASSWORD (Settings → Credentials). Abilitalo INSIEME al '
      + 'workflow di lead generation.',
    category: 'crm',
    tags: ['opt-out', 'gdpr', 'email', 'stop', 'compliance'],
    language: 'it',
    vendor: 'flowforge',
    difficulty: 'intermediate',
    estimatedSetupMin: 8,
    requiredIntegrations: ['trigger_imap', 'logic_if', 'db_insert'],
    nodes: [
      { id: 'imap', defId: 'trigger_imap', x: 60, y: 200, config: {
        systemAccountId: '', host: '', port: '993', username: '', password: '{{ secrets.SMTP_PASSWORD }}',
        mailbox: 'INBOX', pollIntervalSec: '300', onlyUnseen: 'true',
      } },
      { id: 'is_stop', defId: 'logic_if', x: 340, y: 200, config: {
        condition: '/\\bstop\\b/i.test(($node.imap.json.text || "") + " " + ($node.imap.json.subject || ""))',
      } },
      { id: 'blocca', defId: 'db_insert', x: 620, y: 120, config: {
        databaseId: 'crm_db', table: 'opt_out', onConflict: 'ignore',
        rowJson: '{"email":{{ JSON.stringify($node.imap.json.from || "") }},"motivo":"risposta STOP"}',
      } },
    ],
    edges: [
      { from: 'imap', to: 'is_stop' }, { from: 'is_stop', to: 'blocca', fromPort: 'true' },
    ],
    tablesToCreate: [
      {
        databaseId: 'crm_db', name: 'opt_out',
        description: 'Email che hanno risposto STOP — mai ricontattare (GDPR).',
        columns: [
          { name: 'email', type: 'text', primaryKey: true, nullable: false },
          { name: 'motivo', type: 'text' },
          { name: 'creato_il', type: 'datetime' },
        ],
      },
    ],
  },
];

export function findTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}

export function templatesByCategory(category: TemplateCategory): WorkflowTemplate[] {
  return WORKFLOW_TEMPLATES.filter((t) => t.category === category);
}

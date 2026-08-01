# ADR 0002 — Il sync engine è il prodotto

- **Status**: Accepted
- **Date**: 2026-05-25
- **Deciders**: Owner del prodotto + Claude

## Contesto

Quando si progetta un client email, la tentazione è di partire dall'AI, dalla UI «bella», dalle integrazioni multi-provider. Sono i pezzi più visibili e gratificanti da realizzare.

La realtà del dominio è diversa. Un client email che mostra:

- 19 copie della stessa mail,
- una mail del 2018 marcata «non letta»,
- un thread spezzato in due perché il `Message-ID` è stato perso in un round trip Gmail→Outlook,
- una folder con UID validity cambiata e nessun rebuild che la ricostruisce,

è un client email **rotto**, indipendentemente da quanto è elegante la sua UI o intelligente il suo agente.

IMAP è un protocollo del 1986, inconsistente di fatto: ogni server lo interpreta in modo lievemente diverso. Gmail, formalmente IMAP, è in realtà "IMAP con personalità multiple": labels (non folder), conversations (non threading RFC 5322), UIDVALIDITY che cambia capricciosamente. Outlook ha le sue. I provider self-hosted (Dovecot, Postfix+Cyrus, Zimbra, …) hanno bug propri.

## Decisione

Trattiamo il **sync engine** (crate `packages/mail-core/crates/mail-sync/`) come il **deliverable primario** del prodotto. La sua Fase di sviluppo (Fase 2 in roadmap) ha:

- **4-5 settimane dedicate**, prima di iniziare la UI Email vera e propria.
- Una **suite di test integration con `greenmail`** (server IMAP/SMTP fake in Docker) obbligatoria — non opzionale.
- Un **soak test di 24 ore** su account reale del mantenitore prima di dichiarare la fase done.

Il sync engine deve garantire 6 **invarianti non negoziabili**:

1. **Zero duplicati visibili**, mai. Anche con UIDVALIDITY change, anche tra account multipli che ricevono lo stesso messaggio.
2. **Nessuno stato di lettura fantasma** — un messaggio del 2018 non compare «non letto» oggi.
3. **Threading coerente cross-provider** — una conversazione iniziata su Gmail e proseguita su Outlook è un solo thread.
4. **Recovery da disconnessione** a qualunque scala temporale (5 min, 12 ore, 3 giorni offline).
5. **Idempotenza** — rilanciare un sync interrotto a metà non produce duplicati e non perde messaggi.
6. **Progress visibile in tempo reale** via eventi `sync:*` su `tokio::sync::broadcast`.

## Edge case esplicitamente indirizzati

Sono parte del contratto del sync engine, non «se rimane tempo»:

- **UIDVALIDITY change**: rebuild completo del folder; il dedup per `Message-ID` salva i contenuti.
- **Gmail labels vs folder**: un messaggio sta in N etichette ma è una sola riga in `email_messages`; join via `email_message_labels`.
- **Threading**: hash deterministico SHA-1 di `references[0] || in_reply_to || message_id || "from|date|subject"` (porting 1:1 della logica di `email-imap.mjs` che funziona).
- **Internal-date drift**: ordinamento usa il timestamp originale del server, mai `now()`.
- **STARTTLS vs implicit TLS** (porte 993/465/587/143): strategia con 4 tentativi (heuristic → opposite → legacy `minVersion=TLSv1` → plaintext) con cache `lastGoodProfile` per account.
- **IDLE drop silenzioso** (NAT timeout, server bug): heartbeat watchdog 12 min + IDLE restart 25 min, reconnect exponential backoff `[5s, 15s, 30s, 60s, 120s, 300s]`.
- **Send race**: messaggio inviato via SMTP poi rimbalzato in INBOX dal loop server — `Message-ID` self-generato permette dedup immediato.
- **Tracker pixel**: blocco di default, toggle utente per messaggio.

## Conseguenze

### Positive

- La fiducia dell'utente nel prodotto nasce dal sync. Senza, il resto è cosmesi.
- Una volta che il sync regge i 6 invarianti, costruire UI e AI sopra è genuinamente più facile (lavorano su uno stato consistente).
- Bug futuri di sincronizzazione hanno test deterministici (`greenmail`) e si possono regredire in fretta.

### Negative

- La Fase 2 ritarda di 4-5 settimane il momento in cui l'utente vede una UI funzionante.
- Investimento iniziale alto in infrastruttura di test (Docker `greenmail`, account sandbox Gmail/Outlook, soak harness).

### Vincoli operativi

- Niente shortcut «proviamo solo con Gmail per ora» — il dedup cross-provider deve funzionare dal giorno 1, perché la sua assenza emerge solo a tempi lunghi e poi è difficile da retrofittare.
- Niente «vediamo se IDLE serve» — IDLE è l'unico modo per avere latenza < 5s sulle nuove email senza polling aggressivo. Il polling resta solo come fallback.

## Riferimenti

- Architettura del sync: §3 del piano interno, non incluso nel repository.
- Logica di riferimento JS: `email-imap.mjs` del toolkit NHA (repository privato).
- `greenmail`: https://greenmail-mail-test.github.io/greenmail/
- `async-imap`: https://crates.io/crates/async-imap

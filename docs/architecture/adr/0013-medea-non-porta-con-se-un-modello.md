# ADR 0013 — Medea non porta con sé un modello

- **Data**: 2026-10-11
- **Stato**: accettata
- **Supera**: ADR 0004, nella parte che lega gli strumenti a un modello preciso
- **Contesto**: `apps/desktop/src/features/ai/`, `apps/desktop/src-tauri/src/{claude_cli,mcp,runtime}/`,
  `apps/engine/src/services/llm*`

## Il problema

Il servizio a cui Medea si appoggiava come modello gratuito è stato chiuso.
Era presente in tre ruoli, e nessuno dei tre era dichiarato come dipendenza:

1. **predefinito nel desktop**: chi non sceglieva un provider finiva lì;
2. **ripiego nel motore dei workflow**: un nodo AI senza chiave girava lo
   stesso, perché il motore aveva quel servizio in tasca;
3. **ragione dei nomi degli strumenti**: l'ADR 0004 li allineava a quelli che
   quel modello conosceva dall'addestramento.

Tolto il servizio, togliere il nome dal codice non bastava. Il secondo ruolo
nascondeva due difetti che nessuno aveva mai incontrato:

- il desktop **non consegnava mai** al motore le chiavi dei provider;
- anche a consegnarle, il motore le avrebbe **rifiutate**: in produzione non
  cifra senza una password maestra, e il desktop lo avviava senza.

## La decisione

### 1. Nessun provider predefinito, in nessun punto

Nel desktop il provider attivo è una scelta dell'utente o non c'è
(`activeProvider(): ProviderId | null`). Nel motore un campo provider vuoto o
sconosciuto vale «il provider del tenant»; se manca anche quello l'errore lo
dice. Non esiste un modello di ripiego.

Un ripiego silenzioso produce l'errore di un provider che l'utente non ha mai
scelto. Uno stato vuoto dichiarato produce una frase che dice dove andare.

### 2. I nomi degli strumenti restano, per un'altra ragione

I 63 strumenti non si rinominano. Non più perché un modello li conosce: perché
compaiono nelle conversazioni salvate e nella configurazione dei client MCP di
chi usa `medea_mcp` da fuori.

### 3. Il desktop è la fonte delle chiavi, il motore ne tiene una copia cifrata

- Il desktop genera la password maestra del motore, la conserva nel
  portachiavi di sistema e la passa al processo figlio nell'ambiente. Non in
  un file: sarebbe la password in chiaro accanto al database che protegge.
- All'apertura della sessione, e a ogni cambio di chiave o di provider, il
  desktop allinea il motore: scrive le chiavi che ha, toglie quelle che non ha
  più, dichiara il provider preferito.
- «Claude (abbonamento)» e l'endpoint personale non esistono nel motore. Con
  uno dei due scelto, i workflow usano il primo provider che ha una chiave. Le
  Impostazioni lo dicono.

### 4. Claude in abbonamento: la CLI ragiona, Medea decide

La CLI `claude` viene avviata senza strumenti suoi, con il solo server MCP di
Medea, permessi espliciti e senza l'ambiente personale dell'utente
(impostazioni, istruzioni, comandi). La modalità «plan» usata fino alla 0.5
bloccava ogni strumento esterno, lettura compresa.

La CLI gira senza nessuno davanti, quindi non può chiedere un permesso. Il
server MCP avviato da Medea (`--consenso-app`) **non esegue** gli strumenti che
modificano dati: li annuncia. Medea riceve il turno con le chiamate, mostra le
bozze, e chiede la conferma all'utente prima di eseguire.

Un client MCP esterno conserva il comportamento di prima: la conferma è sua.

### 5. I modelli predefiniti si verificano alla fonte

Un modello predefinito ritirato non rompe la compilazione: dà un 404 al primo
utente. `modelli-ritirati.guard.test.ts` tiene l'elenco dei modelli ritirati
con la fonte, e fallisce indicando i file in cui ne resta uno.

## Cosa si è scartato

- **Sostituire il servizio chiuso con un altro predefinito.** Sposterebbe la
  dipendenza invece di toglierla, e sceglierebbe al posto dell'utente dove
  mandare la sua posta.
- **Eseguire gli strumenti sensibili dal server MCP e fidarsi della CLI.** In
  modalità non interattiva la CLI approva tutto ciò che le è permesso: sarebbe
  una modifica senza conferma.
- **Negare gli strumenti sensibili alla CLI.** Il modello leggerebbe «permesso
  negato» e lo riferirebbe all'utente come un errore, invece di proporre
  l'azione.
- **File del turno nella cartella temporanea di sistema.** Su una macchina con
  più utenti un altro utente può preparare un file con lo stesso nome e far
  avviare alla CLI un programma suo.

## Conseguenze

- Un workflow salvato con il provider tolto usa ora il provider del tenant.
- La colonna `tenant_ai_preferences.allow_liara` viene eliminata dalla
  migrazione.
- Restano nel motore alcuni meccanismi generici che nessun provider attuale
  attiva: `LlmContextOverflowError`, `LlmQuotaExceededError` con
  `parseQuotaError`, `engine/quota-pause.ts`, `internalGatewayTrustedHost`, lo
  schema vincolato dietro `MEDEA_SCAFFOLD_CONSTRAINED_SCHEMA`. Non sono legati
  al servizio chiuso e servono a un endpoint OpenAI-compatibile che li
  produca; toglierli è una decisione a parte.
- I segreti dei workflow (`/variables`) erano già salvati dal motore: la
  password maestra ora esiste, ma verificare che anche quelli passino dalla
  cifratura è lavoro da fare.

## Limiti noti

- La ricerca della CLI su Windows e il lancio tramite `claude.cmd` non sono
  stati provati su una macchina Windows.
- Il turno della CLI non è interrompibile dall'interfaccia.
- I modelli OpenAI predefiniti (`gpt-4o`, `gpt-4o-mini`) non compaiono più fra
  i correnti nella documentazione, ma non risultano ritirati: non sono stati
  cambiati.

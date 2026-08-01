# ADR 0006 — Il quality gate decide cosa può essere consegnato

**Stato**: accettata — 2026-07-31
**Contesto**: `apps/desktop/src/features/workflows/`

## Il problema

Lo scaffold AI deve funzionare con qualunque provider. Liara avrà un LoRA
addestrato su FlowForge; gli altri — Claude, GPT, i modelli locali — no. Per
loro il catalogo dei nodi è materiale nuovo a ogni richiesta.

La validazione strutturale (`scaffold/validate.ts`) non basta a proteggere
l'utente. Risponde a «il workflow è ben formato?»: i `defId` esistono, i campi
obbligatori ci sono, gli archi puntano a nodi veri. Un workflow può superarla
in pieno ed essere comunque inutile:

- `smtpHost: "smtp.example.com"` — fallisce al primo invio;
- un trigger senza archi in uscita — non parte mai;
- un nodo che legge `{{$node.X.json}}` dove X viene dopo di lui — campo vuoto,
  in silenzio;
- una `db_query` che emette una lista collegata a una `db_insert` che ne
  elabora una alla volta;
- una `password` scritta in chiaro, che finisce nel JSON esportato.

Nessuno di questi è un errore di forma. Tutti fanno sembrare Medea rotta.

## La decisione

**Un workflow che non supera il quality gate non viene consegnato.** Vale per
entrambi i percorsi di generazione, quello in un colpo solo e quello a
strumenti, e vale indipendentemente dal provider.

Le 21 regole sono il **port fedele** di quelle del runtime FlowForge: stessi
codici, stessa severità, stessi confini. Un workflow bocciato in Medea deve
essere bocciato anche sul server, altrimenti l'utente riceve due giudizi
diversi sullo stesso file e non sa a quale credere.

Tre livelli di gravità, con conseguenze diverse:

| Gravità    | Significato                       | Conseguenza                  |
| ---------- | --------------------------------- | ---------------------------- |
| `critical` | a runtime si romperebbe di sicuro | il workflow non passa        |
| `medium`   | funziona, ma qualcosa non va      | avviso mostrato all'utente   |
| `info`     | osservazione                      | nessuna, resta nel resoconto |

## Il richiamo invece del rifiuto

Quando l'agente chiama `finish` su un workflow con problemi critici, la scelta
ovvia sarebbe restituire un fallimento. È quella sbagliata: butta via tutto il
lavoro fatto per un `example.com` che il modello correggerebbe in un colpo.

L'agente **gli dice cosa non va e lo lascia continuare**, fino a tre richiami
(`MAX_PUSHBACKS`). Solo dopo rinuncia, e restituisce comunque lo stato
parziale: un workflow all'80% è recuperabile a mano, un fallimento nudo no.

Nel percorso in un colpo solo la stessa cosa avviene attraverso i tentativi già
esistenti: i problemi critici tornano al modello come `previousErrors` e fanno
scattare il tentativo successivo, esattamente come le violazioni strutturali.
Il numero di tentativi resta la misura della qualità del provider.

Le regole girano anche dentro `validate_workflow`, non solo alla fine. Un
modello che scopre il segnaposto mentre costruisce lo corregge subito, invece
di arrivare in fondo e vedersi respingere.

## Struttura

Sul server il quality gate è un file da 920 righe. Qui è diviso per materia —
topologia, forma dei dati, valori, configurazione, database, semantica,
intenzione — più un `gate.ts` che li mette in fila e ordina il verdetto.
Aggiungere una regola significa toccare un file da 150 righe e aggiungere una
riga all'elenco.

I falsi allarmi sono il rischio principale di ogni euristica, quindi ogni
regola prudente ha il suo caso innocente nei test: `{{secrets.X}}` non è un
segnaposto, `apiKeyHeaderName` non è un segreto, `__USE_PICKER__` non è un
valore inventato, un `logic_loop` con `strategy="batch"` non sta ripetendo
l'aggregazione. Il test che conta più di tutti è quello che verifica che un
workflow sano non produca **nemmeno un avviso**.

## Conseguenze

- Lo scaffold funziona allo stesso modo con provider addestrati e non: i
  primi arrivano in fondo in un giro, i secondi in due o tre. Nessuno dei due
  può consegnare qualcosa di rotto.
- Le liste delle regole (nodi che emettono liste, aggregatori, modelli
  ritirati) vanno tenute allineate a quelle del server. È una riga per volta,
  ma va fatta da entrambe le parti.
- Le regole sui database restano spente finché l'app non conosce lo schema.
  Tacere è la scelta giusta: inventare un errore su una tabella che non
  possiamo verificare sarebbe peggio che non dire nulla.

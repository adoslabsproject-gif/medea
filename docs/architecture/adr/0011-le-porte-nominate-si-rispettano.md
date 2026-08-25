# ADR 0011 — Le porte nominate si rispettano

- **Stato**: accettato
- **Data**: 2026-08-16
- **Riguarda**: `apps/engine/src/engine/workflow-engine.ts`, i nodi con `outputs` in `packages/engine/nodes/stdlib`

## Il fatto

Il wizard ha consegnato «Email con parole chiave»:

```
trigger_imap → action_filter → community_telegram
```

L'intenzione era: avvisami su Telegram quando arriva una email con «urgente» o
«scadenza». Il workflow avrebbe mandato l'avviso **a ogni email**.

`action_filter` calcola un ramo — `kept` se qualcosa è passato, `removed`
altrimenti — e lo restituisce insieme all'output. Il motore quel ramo lo
buttava via, perché `nodeIsBranchable` guarda `branching: true`, e il filtro
non lo dichiara. Tutti i nodi a valle partivano comunque, su qualsiasi porta.

Lo stesso vale per `action_validate` (`valid`/`invalid`) e `action_compare`
(`equal`/`different`): tre nodi che scelgono un ramo che nessuno leggeva.

Il difetto era doppiamente nascosto: l'esempio d'oro che insegna al modello a
scrivere `fromPort: "kept"` costruiva un edge che non voleva dire niente, e chi
disegnava a mano nel canvas collegava una porta credendo di aver detto qualcosa.

## Perché era così

La distinzione fra `branching: true` e `outputs` è giusta e resta. `outputs`
serve a due cose diverse:

- **porte di instradamento** — `logic_if` manda l'esecuzione di là o di qua;
- **suggerimenti di schema** — `pdf_extract` dichiara i campi che produce, e
  l'output intero va a tutti.

Il flag `branching` è stato introdotto per non confondere le due, e senza di
esso qualunque nodo con `outputs` avrebbe istradato: un errore peggiore.

Il caso che mancava è il terzo: un nodo che **sceglie un ramo davvero**, ma il
cui output completo ha senso anche per chi non ha chiesto un ramo in
particolare.

## La decisione

Il motore onora la porta scelta **quando qualcuno l'ha nominata**.

Per un nodo che (a) non è `branching: true`, (b) ha restituito un ramo, e (c)
ha almeno un edge uscente il cui `fromPort` è fra le porte che dichiara:

- gli edge che **nominano una porta** seguono solo il ramo scelto;
- gli edge **senza porta** ricevono tutto, come hanno sempre fatto.

I nodi `branching: true` non cambiano: la loro regola resta severa, e un edge
senza porta non parte.

## Le conseguenze

**Compatibilità.** Un workflow salvato con edge senza `fromPort` si comporta
esattamente come prima. È il motivo della clausola (c): finché nessuno nomina
una porta, la selezione non si attiva nemmeno.

**Chi nomina ottiene.** `fromPort: "kept"` adesso vuol dire quello che dice, sia
scritto dal modello sia disegnato a mano.

**Gli scartati sono instradabili.** Il contratto di `action_filter` prometteva
che i `removed` non si perdono; adesso si possono mandare davvero altrove.

## Le alternative scartate

**Mettere `branching: true` su filtro, validate e compare.** Un edge senza porta
smetterebbe di partire: i workflow già salvati si spezzerebbero in silenzio, che
è il difetto da cui siamo partiti, al contrario.

**Lasciare fare al controllo di qualità.** Un avviso non instrada niente. E il
canvas resterebbe un posto dove si collega una porta che non conta.

## Il seguito

Il difetto di generazione che ha portato qui — filtrare un messaggio come se
fosse un elenco — è coperto a parte dalla regola `LISTA_CHE_NON_ARRIVA`
(`apps/engine/src/services/ai-scaffold/rule-lista-che-non-arriva.ts`). Le due
cose sono indipendenti: quella impedisce di generarlo, questa fa sì che una
porta collegata conti.

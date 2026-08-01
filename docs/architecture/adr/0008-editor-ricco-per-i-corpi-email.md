# ADR 0008 — L'editor ricco vive dentro uno schema, e arriva solo quando serve

- **Data**: 2026-08-01
- **Stato**: accettata
- **Contesto**: campi `rich-text` dei nodi (`action_send_email.body`,
  `action_gmail.bodyHtml`, `trigger_form.successMessage`)

## Il problema

Tre campi del catalogo dichiarano `rich-text` e finivano in una casella di
testo. Chi voleva una parola in grassetto scriveva `<b>`. Funziona — il motore
manda HTML — ma vuol dire che per mandare una email formattata bisogna
conoscere l'HTML, e chi lo conosce sbaglia comunque i ritorni a capo fra i
paragrafi.

## La decisione

**Tiptap (ProseMirror) con uno schema chiuso**, caricato per import dinamico.

Tre parti, e la seconda è quella che conta.

### 1. Una libreria, non un editor scritto a mano

Un editor `contenteditable` corretto — selezione, unione dei tag, annulla,
incolla — è settimane di lavoro e comunque peggio di una libreria matura.
`document.execCommand`, l'altra strada breve, è deprecato e produce output
diverso a seconda del motore: `<div>` qui, `<font>` là.

### 2. Lo schema è la decisione, non un dettaglio di configurazione

Un WYSIWYG generico produce `<div>`, `<span style>`, classi, `<font>`: HTML che
il browser mostra benissimo e che Outlook, Gmail e la posta di iOS rendono
ognuno a modo suo. Il risultato è una email che si è vista bene mentre la si
scriveva e arriva storta.

Lo schema di ProseMirror **non è un filtro, è una garanzia strutturale**: il
documento non può contenere nodi che non sono nello schema, quindi l'HTML in
uscita non può contenerli neppure — nemmeno incollando da Word.

Cosa c'è: paragrafo, grassetto, corsivo, link, elenchi, due livelli di titolo,
a capo forzato. È quello che serve a scrivere una email, ed è quello che tutti
i client di posta rendono allo stesso modo dal 2005.

Cosa non c'è, e perché:

| Fuori                                 | Perché                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| colori, font, allineamento            | le prime cose a rompersi fuori dal browser, e nessuna serve a un'automazione      |
| immagini                              | o è remota — e i client la bloccano — o è allegata, che è un altro campo del nodo |
| tabelle, blocchi di codice, citazioni | rese in modo imprevedibile fuori dal browser, e nessuno le chiede in una email    |

`RichTextEditor.dom.test.tsx` lo verifica dando in pasto al documento l'HTML
che arriva davvero: stili inline, `<div class>`, `<img>`, `<script>`. Escono
tutti. Restano grassetto, corsivo, elenchi e link.

### 3. Le espressioni restano testo

Il corpo di una email automatica è per metà `{{$node.x.json.result.nome}}`.
Sono testo normale nel documento — le sostituisce il motore quando parte — e
il pulsante «Dati» le inserisce senza doversi ricordare l'id del nodo. Un test
lo fissa: se un giorno l'editor le trasformasse, anche solo scappando le
graffe, ogni email automatica direbbe la cosa sbagliata e non si capirebbe
perché.

### 4. Arriva solo quando serve

ProseMirror pesa 0,36 MB (0,12 MB compressi) per **tre campi** su circa 1.400
del catalogo. Farli pagare all'avvio a chi apre Medea per leggere la posta
sarebbe sproporzionato.

`ConfigFieldRenderer` lo carica con `lazy()` + `Suspense`, e il ripiego mentre
arriva è una casella di testo normale: chi ha appena cliccato sul campo può
cominciare a scrivere.

Perché funzioni, `RichTextEditor` e il suo schema **non sono esportati dal
barrel** `fields/index.ts` — un import statico da lì li riporterebbe nel bundle
d'avvio e il caricamento pigro non servirebbe più a niente. C'è un commento nel
barrel che lo dice, perché è il genere di cosa che qualcuno «sistema» in buona
fede.

Misurato: bundle d'avvio 2.307 kB prima e dopo; il pezzo separato 377 kB.

## Alternative scartate

- **Restare con la casella di testo.** Onesto ma scarica il lavoro
  sull'utente: per una email in grassetto serve saper scrivere HTML.
- **`contenteditable` + `execCommand`.** Nessuna dipendenza, ma output
  imprevedibile e API deprecata: si finirebbe a rincorrere le differenze fra
  WebView.
- **Un WYSIWYG completo con tutte le estensioni.** Più grande e peggiore: le
  cose in più sono esattamente quelle che si rompono in una email.

## Conseguenze

- Aggiungere una possibilità di formattazione significa **aggiungerla allo
  schema**, e quindi chiedersi prima come la rende Outlook. È l'attrito
  giusto.
- Se un giorno servisse l'editor ricco altrove (un compositore di posta vero),
  lo schema andrà separato: quello di una email scritta a mano può essere più
  largo di quello di una email generata da un'automazione.

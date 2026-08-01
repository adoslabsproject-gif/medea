# Medea

Un client email desktop con dentro un editor di workflow a nodi.

---

## Cosa è

Medea è un client di posta. Scarica la posta via IMAP, la tiene in un SQLite
locale con ricerca full-text, la invia via SMTP. Fin qui niente di nuovo.

La differenza è cosa ci sta accanto: una tab **Workflow** con un editor visuale
di automazioni. Si trascinano i nodi sul canvas, si collegano, si configurano.
Trigger a orario, webhook, chiamate HTTP, query su database, invio email, agenti
AI, integrazioni con servizi esterni: 193 nodi, gli stessi di FlowForge, con le
stesse definizioni e le stesse icone.

E si eseguono. Non «si esporteranno da qualche parte che li esegue»: girano sul
computer, con il motore che sta dentro l'app.

Il formato del documento è compatibile in entrambe le direzioni: un workflow
disegnato in Medea si importa sul server, e uno costruito sul server si apre in
Medea.

## Perché in un client email

Perché è lì che le automazioni servono davvero. «Quando arriva una PEC salvala
nel database e avvisami», «ogni lunedì controlla gli ordini aperti e scrivi un
riepilogo», «se il cliente non risponde entro tre giorni ricordamelo». Sono cose
che si fanno a mano tutti i giorni, e per farle in automatico oggi bisogna
mettere insieme due o tre strumenti diversi che non si parlano.

La posta vive nel computer dell'utente. Un'automazione che deve leggerla deve
girare lì, non su un server a cui quella posta andrebbe prima spedita.

## Si disegna, o si descrive

Il canvas serve a chi sa già cosa vuole. Per tutti gli altri c'è l'assistente:
si scrive «ogni mattina alle 8 scarica gli ordini dal gestionale e mandami il
riepilogo per email» e il workflow viene costruito un passo alla volta.

Non in un colpo solo, e non a memoria. Il modello ha nove strumenti: cerca il
nodo nel catalogo, ne legge lo schema, lo aggiunge, lo configura, valida,
chiude. È il motivo per cui funziona anche con un modello che il catalogo di
FlowForge non l'ha mai visto: non deve ricordarselo, lo interroga mentre lavora.

Funziona con qualunque provider — Claude, GPT, Gemini, modelli locali, o il
modello fine-tuned che sta già sul nostro server. La chiave è dell'utente e sta
nel portachiavi del sistema operativo, non in un file di configurazione.

## Quello che non si salva

Un workflow può essere formalmente perfetto e non funzionare. Tutti i campi
compilati, tutti i nodi collegati, e dentro un `smtp.example.com` che il modello
ha messo perché non sapeva cosa scrivere. Al primo giro fallisce.

Ci sono 21 controlli che guardano il senso, non la forma:

- riferimenti a nodi che, quando quel passo viene eseguito, non sono ancora stati eseguiti;
- valori inventati — `example.com`, `your-api-key`, `my-bucket`, identificativi che non sono identificativi;
- trigger che non portano da nessuna parte;
- una lista collegata a un nodo che elabora un elemento per volta;
- un'aggregazione finita dentro un ciclo, che produrrebbe N riepiloghi invece di uno;
- il ramo del successo che finisce nella coda degli errori;
- segreti scritti in chiaro dentro il documento.

Un workflow con problemi critici **non si può attivare**. Vale sia per quello
disegnato a mano sia per quello generato dall'AI — sarebbe assurdo che il canvas
accettasse in silenzio quello che il generatore rifiuta.

Quando è l'assistente a sbagliare, non viene bocciato al primo colpo: gli si
dice cosa non va e ha tre tentativi per correggere. Quasi sempre al secondo giro
il workflow è a posto.

## Girano da soli

Un'automazione che parte solo mentre la si guarda non è un'automazione, è un
pulsante con un ritardo. In Medea un cron delle 8 scatta anche se la sezione
Workflow non si è mai aperta, e l'esecuzione finisce nello storico con scritto
chi l'ha avviata — «cron», non «Medea». Se non c'è nessuna automazione attiva il
motore non parte affatto.

Le credenziali non stanno nel documento. `{{secrets.API_KEY}}` si risolve dal
portachiavi del sistema operativo, e gli account di posta già configurati in
Medea diventano quelli che i nodi usano per inviare e leggere. Un workflow si
esporta senza portarsi via niente di riservato: sull'originale quelle variabili
stanno in chiaro nel database.

Le tabelle che un workflow dà per esistenti vengono lette dal workflow stesso —
un nodo che scrive su un database nomina la tabella e le colonne — e si creano
premendo un pulsante, invece di scoprire alla prima esecuzione che non c'erano.

## Sotto

Tauri 2: un processo Rust, la WebView del sistema operativo, un file SQLite.
Niente Electron, niente server.

Il motore dei workflow è l'eccezione: è il runtime di FlowForge, quindi Node, e
viaggia dentro l'app con le sue dipendenze e il suo interprete. Sono 595 MB,
quasi tutti moduli nativi che non si possono impacchettare altrimenti. È il
prezzo per avere 193 nodi veri e la sandbox `isolated-vm`, invece di una
manciata di nodi riscritti che fanno il 10% del lavoro.

L'assistente ha 63 strumenti che agiscono davvero sul sistema — leggere la
posta, cercare fra i contatti, comporre documenti, gestire promemoria — e ogni
strumento che modifica qualcosa sospende il turno e chiede conferma. Le bozze
non partono da sole.

## Dove sta

Codice: [github.com/adoslabsproject-gif/medea](https://github.com/adoslabsproject-gif/medea)

## Stato

Posta, assistente, rubrica, documenti funzionano. I workflow si disegnano, si
descrivono a parole, passano i controlli di qualità e **si eseguono**: sandbox
JavaScript, espressioni fra nodi, rami condizionali, chiamate HTTP reali, un
nodo che fallisce che ferma il flusso. Il cron parte da solo.

Manca ancora: le versioni con ritorno indietro, la prova del singolo nodo, la
riesecuzione di un'esecuzione passata, i nodi di comunità dal registry. E i
webhook in ingresso, che sono l'unica cosa per cui serve un server — un computer
dietro NAT non è raggiungibile dall'esterno, e quel pezzo resterà disattivato di
default.

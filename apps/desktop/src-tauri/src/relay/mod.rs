//! Il canale verso l'esterno, tenuto aperto da qui e non dalla pagina.
//!
//! Un computer dietro un NAT non lo raggiunge nessuno da internet. Può però
//! aprire un canale **in uscita**: Medea tiene un WebSocket verso un relay, e
//! le chiamate che arrivano da fuori scendono dentro quel canale. Nessuna
//! porta aperta sul router, nessun indirizzo IP da conoscere.
//!
//! ───── Perché sta in Rust e non nella pagina ─────
//!
//! Prima il WebSocket lo apriva il codice della pagina. Funzionava, ma la
//! pagina vive sotto una CSP che elenca a uno a uno gli indirizzi
//! raggiungibili: con il relay ufficiale andava bene, e chiunque volesse
//! usare **il proprio** relay — un server suo, un dominio suo, un indirizzo
//! IP — veniva bloccato dal browser. L'unica via sarebbe stata allargare la
//! CSP a qualunque destinazione, cioè spegnere una difesa vera per tutti allo
//! scopo di accontentare pochi.
//!
//! Qui quel limite non c'è: la connessione parte dal processo, non dalla
//! pagina, e l'indirizzo del relay lo decide chi usa Medea.
//!
//! ───── Il confine ─────
//!
//! Si inoltrano **solo i percorsi `/webhooks/…`**. Il relay applica lo stesso
//! controllo dalla sua parte; qui si ripete perché è la cosa che non deve
//! fallire nemmeno se l'altra metà venisse sostituita da qualcos'altro. Senza,
//! chi conosce l'identificativo pubblico raggiungerebbe tutta l'API locale del
//! motore — quella che crea workflow ed esegue codice.

use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

mod frames;

pub use frames::{is_forwardable, socket_url};

/// Quanto si aspetta prima di riprovare, e fino a quanto si allunga l'attesa.
const RETRY: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(60);

/// L'evento con cui la pagina viene informata di come va il canale.
const EVENTO: &str = "relay://stato";

/// Come sta il canale, per chi guarda.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelayState {
    pub connected: bool,
    /// L'identificativo pubblico, quando il relay lo conferma.
    pub install_id: Option<String>,
    pub error: Option<String>,
}

/// Quello che arriva dal relay.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Inbound {
    Ready {
        #[serde(rename = "installId")]
        install_id: String,
    },
    Request(frames::RequestFrame),
}

struct Canale {
    /// Si chiude annullando il compito che lo tiene aperto.
    handle: tauri::async_runtime::JoinHandle<()>,
}

static CANALE: OnceCell<Mutex<Option<Canale>>> = OnceCell::new();
static STATO: OnceCell<Mutex<RelayState>> = OnceCell::new();

fn canale() -> &'static Mutex<Option<Canale>> {
    CANALE.get_or_init(|| Mutex::new(None))
}

fn stato() -> &'static Mutex<RelayState> {
    STATO.get_or_init(|| Mutex::new(RelayState::default()))
}

/// Come sta il canale adesso.
pub fn status() -> RelayState {
    stato().lock().expect("stato del relay avvelenato").clone()
}

fn pubblica(app: &AppHandle, next: RelayState) {
    *stato().lock().expect("stato del relay avvelenato") = next.clone();
    let _ = app.emit(EVENTO, next);
}

/// Apre il canale. Chiamarla due volte non ne apre due.
pub fn start(app: AppHandle, base_url: String, token: String) -> Result<()> {
    let mut slot = canale().lock().expect("canale avvelenato");
    if slot.is_some() {
        return Ok(());
    }

    // L'indirizzo si valida subito: un errore di battitura deve dirlo adesso,
    // non fra due secondi dentro un tentativo di riconnessione.
    let url = socket_url(&base_url).context("indirizzo del relay non valido")?;

    let handle = tauri::async_runtime::spawn(async move {
        tieni_aperto(app, url, token).await;
    });
    *slot = Some(Canale { handle });
    Ok(())
}

/// Chiude il canale e smette di riprovare.
pub fn stop(app: &AppHandle) {
    let mut slot = canale().lock().expect("canale avvelenato");
    if let Some(canale) = slot.take() {
        canale.handle.abort();
    }
    pubblica(app, RelayState::default());
}

/// Riprova finché non gli si dice di smettere, allungando l'attesa.
///
/// Se il relay è irraggiungibile non ha senso bussare ogni due secondi; se
/// invece regge, l'attesa torna breve, altrimenti una caduta isolata la
/// lascerebbe a un minuto per sempre.
async fn tieni_aperto(app: AppHandle, url: String, token: String) {
    let mut attesa = RETRY;
    loop {
        match sessione(&app, &url, &token).await {
            Ok(()) => attesa = RETRY,
            Err(e) => {
                pubblica(
                    &app,
                    RelayState {
                        connected: false,
                        install_id: None,
                        error: Some(e.to_string()),
                    },
                );
            }
        }
        tokio::time::sleep(attesa).await;
        attesa = (attesa * 2).min(RETRY_MAX);
    }
}

/// Una connessione, dall'apertura alla caduta.
async fn sessione(app: &AppHandle, url: &str, token: &str) -> Result<()> {
    let (stream, _) = tokio_tungstenite::connect_async(url)
        .await
        .context("il relay non risponde")?;
    let (mut write, mut read) = stream.split();

    write
        .send(Message::Text(
            serde_json::json!({ "type": "hello", "token": token })
                .to_string()
                .into(),
        ))
        .await?;

    while let Some(messaggio) = read.next().await {
        let testo = match messaggio? {
            Message::Text(t) => t,
            // Il protocollo è testo. Il resto — ping, binario — lo gestisce
            // la libreria o non ci riguarda.
            _ => continue,
        };

        let Ok(frame) = serde_json::from_str::<Inbound>(&testo) else {
            continue;
        };

        match frame {
            Inbound::Ready { install_id } => {
                pubblica(
                    app,
                    RelayState {
                        connected: true,
                        install_id: Some(install_id),
                        error: None,
                    },
                );
            }
            Inbound::Request(richiesta) => {
                let esito = frames::serve(&richiesta).await;
                let risposta = serde_json::json!({
                    "type": "response",
                    "id": richiesta.id,
                    "status": esito.status,
                    "body": esito.body,
                });
                write
                    .send(Message::Text(risposta.to_string().into()))
                    .await?;
            }
        }
    }

    // Il flusso è finito senza errori: il relay ha chiuso.
    pubblica(
        app,
        RelayState {
            connected: false,
            install_id: status().install_id,
            error: None,
        },
    );
    Ok(())
}

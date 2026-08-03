//! Fermare davvero un'inferenza in corso.
//!
//! Un pulsante «stop» che si limita a smettere di aspettare non ferma niente:
//! il modello continua a generare, il provider continua a contare i token, e
//! la risposta arriva lo stesso — solo che nessuno la guarda più. Per un ciclo
//! come quello che costruisce un workflow, dove ogni passo è una chiamata,
//! significa che dopo lo stop il lavoro prosegue per decine di secondi.
//!
//! Qui ogni richiesta può portarsi dietro un identificativo. Finché è in volo,
//! quell'identificativo ha un interruttore associato; chiamare `ai_chat_abort`
//! lo aziona e la richiesta HTTP viene chiusa sul posto — la connessione cade,
//! e il provider se ne accorge.
//!
//! L'identificativo lo sceglie chi chiama, ed è suo: due cicli diversi non si
//! fermano a vicenda.

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::OnceCell;
use tokio_util::sync::CancellationToken;

static IN_VOLO: OnceCell<Mutex<HashMap<String, CancellationToken>>> = OnceCell::new();

fn registro() -> &'static Mutex<HashMap<String, CancellationToken>> {
    IN_VOLO.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registra una richiesta e restituisce l'interruttore da tenere d'occhio.
///
/// Se lo stesso identificativo era già in uso, quello di prima viene azionato:
/// vuol dire che chi chiama ha ricominciato senza chiudere il giro precedente,
/// e lasciarlo in volo sarebbe una richiesta che nessuno aspetta più.
pub fn registra(id: &str) -> CancellationToken {
    let token = CancellationToken::new();
    let mut mappa = registro()
        .lock()
        .expect("registro delle inferenze avvelenato");
    if let Some(vecchio) = mappa.insert(id.to_string(), token.clone()) {
        vecchio.cancel();
    }
    token
}

/// Toglie una richiesta dal registro: è finita, in un modo o nell'altro.
pub fn dimentica(id: &str) {
    registro()
        .lock()
        .expect("registro delle inferenze avvelenato")
        .remove(id);
}

/// Ferma la richiesta con questo identificativo, se è ancora in volo.
///
/// Non è un errore fermare qualcosa che è già finito: chi preme stop non può
/// sapere se la risposta era già arrivata mentre lo premeva.
#[tauri::command]
pub fn ai_chat_abort(request_id: String) {
    let token = registro()
        .lock()
        .expect("registro delle inferenze avvelenato")
        .remove(&request_id);
    if let Some(token) = token {
        token.cancel();
        tracing::info!("Inferenza «{request_id}» fermata su richiesta");
    }
}

/// Quante inferenze sono in volo. Serve ai test.
#[cfg(test)]
pub fn in_volo() -> usize {
    registro()
        .lock()
        .expect("registro delle inferenze avvelenato")
        .len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fermare_aziona_l_interruttore() {
        let token = registra("prova-1");
        assert!(!token.is_cancelled());
        ai_chat_abort("prova-1".to_string());
        assert!(token.is_cancelled());
    }

    #[test]
    fn fermare_qualcosa_di_gia_finito_non_e_un_errore() {
        // Chi preme stop non può sapere se la risposta era già arrivata.
        ai_chat_abort("mai-esistita".to_string());
    }

    #[test]
    fn lo_stesso_identificativo_ferma_il_giro_precedente() {
        let primo = registra("prova-2");
        let secondo = registra("prova-2");
        assert!(primo.is_cancelled(), "il primo doveva essere fermato");
        assert!(!secondo.is_cancelled());
        dimentica("prova-2");
    }

    #[test]
    fn una_richiesta_finita_esce_dal_registro() {
        let prima = in_volo();
        registra("prova-3");
        assert_eq!(in_volo(), prima + 1);
        dimentica("prova-3");
        assert_eq!(in_volo(), prima);
    }
}

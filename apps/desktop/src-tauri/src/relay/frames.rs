//! Cosa passa dal canale, e dove va a finire.
//!
//! Due responsabilità sole: decidere se una chiamata arrivata da internet ha
//! il diritto di proseguire, e girarla al motore che gira su questo computer.

use std::collections::HashMap;

use anyhow::Result;
use serde::Deserialize;

/// Una chiamata arrivata dal relay.
#[derive(Debug, Deserialize)]
pub struct RequestFrame {
    pub id: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: String,
}

/// Cosa si rimanda indietro.
pub struct Esito {
    pub status: u16,
    pub body: String,
}

/// L'indirizzo del WebSocket, ricavato da quello del relay.
///
/// `https` diventa `wss` e `http` diventa `ws`; qualunque altro schema è un
/// errore, non una cosa da correggere in silenzio.
pub fn socket_url(base_url: &str) -> Result<String> {
    let pulito = base_url.trim().trim_end_matches('/');
    let (schema, resto) = pulito
        .split_once("://")
        .ok_or_else(|| anyhow::anyhow!("manca lo schema: «{base_url}»"))?;
    let ws = match schema {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        altro => anyhow::bail!("schema non supportato: «{altro}»"),
    };
    if resto.is_empty() {
        anyhow::bail!("manca l'indirizzo dopo lo schema");
    }
    Ok(format!("{ws}://{resto}/socket"))
}

/// Solo i webhook passano. Vedi il commento in cima al modulo padre.
///
/// Si guarda il percorso senza la parte dopo il punto interrogativo, e si
/// pretende che cominci per `/webhooks/` e non contenga altro che caratteri
/// innocui — niente `..`, niente barre doppie che alcuni server normalizzano
/// in modi sorprendenti.
pub fn is_forwardable(path: &str) -> bool {
    let percorso = path.split('?').next().unwrap_or("");
    let Some(coda) = percorso.strip_prefix("/webhooks/") else {
        return false;
    };
    !coda.is_empty()
        // Una barra subito dopo il prefisso significa `/webhooks//…`: la
        // doppia barra sta a cavallo fra prefisso e coda, e guardare solo
        // dentro la coda non la vedrebbe.
        && !coda.starts_with('/')
        && !coda.contains("//")
        && coda
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-'))
}

/// Gira la chiamata al motore locale e restituisce cosa risponde.
///
/// Un errore qui non è un errore del relay: è il motore che non risponde, e
/// chi ha chiamato deve leggerlo come tale invece di aspettare il timeout.
pub async fn serve(frame: &RequestFrame) -> Esito {
    if !is_forwardable(&frame.path) {
        return Esito {
            status: 403,
            body: r#"{"error":"Solo i webhook passano da qui."}"#.to_string(),
        };
    }

    let Some(base) = crate::runtime::status().base_url else {
        return Esito {
            status: 502,
            body: r#"{"error":"Il motore dei workflow non è in funzione."}"#.to_string(),
        };
    };

    match inoltra(&base, frame).await {
        Ok(esito) => esito,
        Err(e) => Esito {
            status: 502,
            body: serde_json::json!({ "error": e.to_string() }).to_string(),
        },
    }
}

async fn inoltra(base_url: &str, frame: &RequestFrame) -> Result<Esito> {
    let cliente = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let metodo =
        reqwest::Method::from_bytes(frame.method.as_bytes()).unwrap_or(reqwest::Method::POST);
    let mut richiesta = cliente.request(metodo.clone(), format!("{base_url}{}", frame.path));

    for (nome, valore) in &frame.headers {
        // `host` e `content-length` li ricalcola il client: passarli così
        // com'erano descriverebbe una richiesta diversa da quella che parte.
        if nome.eq_ignore_ascii_case("host") || nome.eq_ignore_ascii_case("content-length") {
            continue;
        }
        richiesta = richiesta.header(nome, valore);
    }

    if !matches!(metodo, reqwest::Method::GET | reqwest::Method::HEAD) {
        richiesta = richiesta.body(frame.body.clone());
    }

    let risposta = richiesta.send().await?;
    let status = risposta.status().as_u16();
    Ok(Esito {
        status,
        body: risposta.text().await.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passano_solo_i_webhook() {
        assert!(is_forwardable("/webhooks/wf-1/token"));
        assert!(is_forwardable("/webhooks/abc?x=1"));

        // Tutto il resto dell'API locale resta fuori: è quella che crea
        // workflow ed esegue codice.
        assert!(!is_forwardable("/api/v1/workflows"));
        assert!(!is_forwardable("/webhooks"));
        assert!(!is_forwardable("/webhooks/"));
        assert!(!is_forwardable("/"));
    }

    #[test]
    fn niente_risalite_o_barre_doppie() {
        assert!(!is_forwardable("/webhooks/../api/v1/workflows"));
        assert!(!is_forwardable("/webhooks//api"));
        assert!(!is_forwardable("/webhooks/a%2e%2e/b"));
    }

    #[test]
    fn lo_schema_diventa_quello_del_websocket() {
        assert_eq!(
            socket_url("https://esempio.it/relay").unwrap(),
            "wss://esempio.it/relay/socket"
        );
        assert_eq!(
            socket_url("http://192.168.1.50:8080/relay/").unwrap(),
            "ws://192.168.1.50:8080/relay/socket"
        );
        // Chi ha già scritto wss non va corretto due volte.
        assert_eq!(
            socket_url("wss://relay.mio.dominio").unwrap(),
            "wss://relay.mio.dominio/socket"
        );
    }

    #[test]
    fn un_indirizzo_storto_lo_dice_subito() {
        assert!(socket_url("esempio.it/relay").is_err());
        assert!(socket_url("ftp://esempio.it").is_err());
        assert!(socket_url("https://").is_err());
    }
}

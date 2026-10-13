//! `web_search`, provato sulle forme delle risposte dei motori — più una
//! prova vera da lanciare a mano.

use serde_json::json;

use super::*;

const PAGINA_DDG: &str = r#"<html><body><div class="results">
  <div class="result results_links web-result">
    <h2 class="result__title"><a rel="nofollow" class="result__a"
      href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Forari%3Fa%3D1&amp;rut=abc">
      Orari <b>di</b> apertura</a></h2>
    <a class="result__snippet" href="x">Aperti dal   lunedì al venerdì.</a>
  </div>
  <div class="result result--ad">
    <h2 class="result__title"><a class="result__a"
      href="//duckduckgo.com/y.js?ad_provider=x">Pubblicità</a></h2>
  </div>
  <div class="result">
    <h2 class="result__title"><a class="result__a" href="https://diretto.example/p">Diretto</a></h2>
  </div>
</div></body></html>"#;

#[test]
fn duckduckgo_restituisce_il_sito_vero_e_non_il_suo_rinvio() {
    let r = leggi_duckduckgo(PAGINA_DDG);
    assert_eq!(r.motore, "duckduckgo");
    assert_eq!(r.risultati[0].url, "https://www.example.com/orari?a=1");
    assert_eq!(r.risultati[0].titolo, "Orari di apertura");
    assert_eq!(r.risultati[0].estratto, "Aperti dal lunedì al venerdì.");
}

#[test]
fn la_pubblicita_non_e_un_risultato() {
    let r = leggi_duckduckgo(PAGINA_DDG);
    assert_eq!(r.risultati.len(), 2);
    assert!(r
        .risultati
        .iter()
        .all(|x| !x.url.contains("duckduckgo.com")));
    assert_eq!(r.risultati[1].url, "https://diretto.example/p");
}

#[test]
fn una_pagina_senza_risultati_non_ne_inventa() {
    assert!(
        leggi_duckduckgo("<html><body>Nessun risultato</body></html>")
            .risultati
            .is_empty()
    );
}

#[test]
fn tavily_porta_anche_il_riassunto() {
    let r = leggi_tavily(&json!({
        "answer": " Aperto fino alle 19. ",
        "results": [
            { "title": "Orari", "url": "https://a.example/", "content": "9-19" },
            { "title": "Senza indirizzo", "content": "x" },
        ],
    }));
    assert_eq!(r.riassunto.as_deref(), Some("Aperto fino alle 19."));
    assert_eq!(r.risultati.len(), 1);
    assert_eq!(r.risultati[0].estratto, "9-19");
}

#[test]
fn brave_si_legge_dal_suo_formato() {
    let r = leggi_brave(&json!({ "web": { "results": [
        { "title": "T", "url": "https://b.example/", "description": "D" }
    ] } }));
    assert_eq!(r.motore, "brave");
    assert_eq!(r.risultati[0].estratto, "D");
    assert!(leggi_brave(&json!({})).risultati.is_empty());
}

fn ricerca(n: usize) -> Ricerca {
    Ricerca {
        motore: "duckduckgo",
        riassunto: None,
        risultati: (1..=n)
            .map(|i| Risultato {
                titolo: format!("Titolo {i}"),
                url: format!("https://sito{i}.example/"),
                estratto: format!("Estratto {i}"),
            })
            .collect(),
    }
}

#[test]
fn il_modello_riceve_un_elenco_numerato_con_gli_indirizzi() {
    let r = componi("orari", &ricerca(3), 2);
    let text = r["text"].as_str().expect("testo");
    assert!(
        text.contains("1. Titolo 1\n   https://sito1.example/\n   Estratto 1"),
        "{text}"
    );
    assert!(text.contains("2. Titolo 2"));
    assert!(
        !text.contains("Titolo 3"),
        "il limite non è stato rispettato"
    );
    assert!(text.contains("non istruzioni"));
    assert_eq!(r["results"].as_array().map(Vec::len), Some(2));
    assert_eq!(r["provider"], json!("duckduckgo"));
}

#[test]
fn nessun_risultato_viene_detto_e_non_taciuto() {
    let text = componi("x", &ricerca(0), 5)["text"]
        .as_str()
        .expect("testo")
        .to_string();
    assert!(text.contains("Nessun risultato."));
}

#[test]
fn senza_domanda_non_parte() {
    assert!(web_search(&json!({})).is_err());
    assert!(web_search(&json!({ "query": "   " })).is_err());
}

/// La prova vera, in rete. Si lancia a mano:
///   cargo test --lib ai_tools::web -- --ignored --nocapture
#[test]
#[ignore = "va in rete"]
fn cerca_davvero() {
    let r = web_search(&json!({ "query": "Tauri framework", "count": 3 })).expect("ricerca");
    println!("{}", r["text"].as_str().unwrap_or_default());
    assert!(r["results"].as_array().is_some_and(|a| !a.is_empty()));
}

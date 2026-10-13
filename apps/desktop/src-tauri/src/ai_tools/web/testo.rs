//! Da una pagina HTML al testo che un modello può leggere.
//!
//! Una pagina è per nove decimi roba che non è contenuto: script, stili,
//! menù, tracciamento. Passarla intera al modello gli riempie il contesto di
//! rumore e gli lascia poco spazio per ragionare. Qui si tiene il testo,
//! con i titoli, gli elenchi e i collegamenti — che servono al modello per
//! decidere quale pagina aprire dopo.

use scraper::node::Node;
use scraper::{ElementRef, Html};
use url::Url;

/// Una pagina ridotta a testo.
#[derive(Debug, Clone, PartialEq)]
pub struct Pagina {
    pub titolo: Option<String>,
    pub testo: String,
}

/// Elementi il cui contenuto non è mai testo da leggere.
const IGNORATI: &[&str] = &[
    "script", "style", "noscript", "template", "svg", "iframe", "head", "canvas", "object",
    "embed", "form", "nav", "button", "select",
];

/// Elementi che stanno su una riga loro.
const BLOCCHI: &[&str] = &[
    "p",
    "div",
    "section",
    "article",
    "main",
    "header",
    "footer",
    "aside",
    "ul",
    "ol",
    "li",
    "table",
    "tr",
    "br",
    "hr",
    "blockquote",
    "pre",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "dl",
    "dt",
    "dd",
    "figure",
    "figcaption",
];

fn assoluto(base: Option<&Url>, href: &str) -> Option<String> {
    let href = href.trim();
    if href.is_empty() || href.starts_with('#') {
        return None;
    }
    let url = match base {
        Some(b) => b.join(href).ok()?,
        None => Url::parse(href).ok()?,
    };
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

fn visita(nodo: ElementRef<'_>, base: Option<&Url>, out: &mut String) {
    for figlio in nodo.children() {
        match figlio.value() {
            Node::Text(t) => out.push_str(t),
            Node::Element(el) => {
                let nome = el.name();
                if IGNORATI.contains(&nome) {
                    continue;
                }
                let Some(elemento) = ElementRef::wrap(figlio) else {
                    continue;
                };
                let blocco = BLOCCHI.contains(&nome);
                if blocco {
                    out.push('\n');
                }
                match nome {
                    "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                        let livello = nome[1..].parse::<usize>().unwrap_or(1);
                        out.push_str(&"#".repeat(livello));
                        out.push(' ');
                    }
                    "li" => out.push_str("- "),
                    "td" | "th" => out.push_str(" | "),
                    _ => {}
                }
                if nome == "a" {
                    let mut etichetta = String::new();
                    visita(elemento, base, &mut etichetta);
                    let etichetta = etichetta.split_whitespace().collect::<Vec<_>>().join(" ");
                    match el.attr("href").and_then(|h| assoluto(base, h)) {
                        Some(url) if !etichetta.is_empty() && etichetta != url => {
                            out.push_str(&format!("[{etichetta}]({url})"));
                        }
                        _ => out.push_str(&etichetta),
                    }
                } else {
                    visita(elemento, base, out);
                }
                if blocco {
                    out.push('\n');
                }
            }
            _ => {}
        }
    }
}

/// Toglie gli spazi ripetuti e le righe vuote in fila.
fn ripulisci(grezzo: &str) -> String {
    let mut righe: Vec<String> = Vec::new();
    for riga in grezzo.lines() {
        let riga = riga.split_whitespace().collect::<Vec<_>>().join(" ");
        if riga.is_empty() {
            if righe.last().is_some_and(|r| !r.is_empty()) {
                righe.push(String::new());
            }
        } else if riga != "-" && riga != "|" {
            righe.push(riga);
        }
    }
    righe.join("\n").trim().to_string()
}

/// Riduce una pagina HTML a testo. `base` serve a rendere assoluti i
/// collegamenti relativi.
pub fn da_html(html: &str, base: Option<&Url>) -> Pagina {
    let documento = Html::parse_document(html);
    let titolo = scraper::Selector::parse("title")
        .ok()
        .and_then(|s| documento.select(&s).next())
        .map(|t| t.text().collect::<String>())
        .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|t| !t.is_empty());

    let mut grezzo = String::new();
    visita(documento.root_element(), base, &mut grezzo);
    Pagina {
        titolo,
        testo: ripulisci(&grezzo),
    }
}

/// Taglia un testo a `massimo` caratteri senza spezzarne uno a metà.
/// Restituisce il testo e se è stato tagliato.
pub fn tronca(testo: &str, massimo: usize) -> (String, bool) {
    match testo.char_indices().nth(massimo) {
        Some((fine, _)) => (testo[..fine].to_string(), true),
        None => (testo.to_string(), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGINA: &str = r#"<!doctype html><html><head><title>  Orari
      di apertura </title><style>body{color:red}</style>
      <script>tracciamento("segreto")</script></head>
      <body><nav><a href="/">Home</a><a href="/chi">Chi siamo</a></nav>
      <h1>Orari</h1><p>Siamo aperti   dal <b>lunedì</b> al venerdì.</p>
      <ul><li>Mattina: 9–13</li><li>Pomeriggio: 15–19</li></ul>
      <p>Per informazioni <a href="/contatti">scrivici</a> oppure
      <a href="https://altro.example/mappa">guarda la mappa</a>.</p>
      <script>altro()</script><noscript>attiva javascript</noscript>
      </body></html>"#;

    fn pagina() -> Pagina {
        let base = Url::parse("https://negozio.example/orari").expect("base");
        da_html(PAGINA, Some(&base))
    }

    #[test]
    fn il_titolo_si_legge_ripulito_dagli_a_capo() {
        assert_eq!(pagina().titolo.as_deref(), Some("Orari di apertura"));
    }

    #[test]
    fn script_stili_e_menu_non_arrivano_al_modello() {
        let testo = pagina().testo;
        for rumore in [
            "tracciamento",
            "color:red",
            "altro()",
            "attiva javascript",
            "Chi siamo",
        ] {
            assert!(!testo.contains(rumore), "è rimasto «{rumore}»:\n{testo}");
        }
    }

    #[test]
    fn il_contenuto_resta_con_titoli_ed_elenchi() {
        let testo = pagina().testo;
        assert!(testo.contains("# Orari"), "{testo}");
        assert!(
            testo.contains("Siamo aperti dal lunedì al venerdì."),
            "{testo}"
        );
        assert!(testo.contains("- Mattina: 9–13"), "{testo}");
        assert!(testo.contains("- Pomeriggio: 15–19"), "{testo}");
    }

    /// Un collegamento relativo non serve a niente a chi non sa da dove
    /// partiva: va reso intero.
    #[test]
    fn i_collegamenti_restano_e_diventano_assoluti() {
        let testo = pagina().testo;
        assert!(
            testo.contains("[scrivici](https://negozio.example/contatti)"),
            "{testo}"
        );
        assert!(
            testo.contains("[guarda la mappa](https://altro.example/mappa)"),
            "{testo}"
        );
    }

    #[test]
    fn un_collegamento_che_non_e_web_perde_l_indirizzo_e_tiene_il_testo() {
        let p = da_html(
            r#"<p><a href="javascript:x()">premi</a> <a href="mailto:a@b.it">scrivi</a></p>"#,
            None,
        );
        assert_eq!(p.testo, "premi scrivi");
    }

    #[test]
    fn niente_righe_vuote_in_fila() {
        let p = da_html(
            "<div><div><p>uno</p></div></div><div></div><div><p>due</p></div>",
            None,
        );
        assert_eq!(p.testo, "uno\n\ndue");
    }

    #[test]
    fn il_taglio_non_spezza_un_carattere_accentato() {
        assert_eq!(tronca("perché", 5), ("perch".to_string(), true));
        assert_eq!(tronca("però", 4), ("però".to_string(), false));
        assert_eq!(tronca("àèìòù", 2), ("àè".to_string(), true));
    }
}

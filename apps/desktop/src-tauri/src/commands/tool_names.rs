//! Rimettere in sesto i nomi degli strumenti che il modello storpia.
//!
//! I modelli della famiglia Qwen — e Liara è uno di quelli — a volte emettono
//! il nome di uno strumento con dei pezzi in più attaccati. Non è casuale: è
//! un difetto noto di come il tokenizzatore ricompone i frammenti, e si vede
//! così, preso da una sessione vera:
//!
//! ```text
//! add_node                    ← giusto
//! _add_node                   ← un trattino basso di troppo davanti
//! connect5c5e83b0c            ← con attaccato un pezzo di identificativo
//! connect5c5e83b0cściół       ← e perfino una parola polacca
//! ```
//!
//! Il modello sta chiamando lo strumento giusto con gli argomenti giusti: è
//! solo il nome ad arrivare sporco. Senza riparazione la chiamata non trova
//! nessuno strumento, il passo fallisce, e dopo abbastanza fallimenti il ciclo
//! si arrende — con un messaggio che dà la colpa al modello, che invece stava
//! facendo il suo lavoro.
//!
//! La riparazione è deliberatamente prudente: si accetta solo quando c'è **un
//! solo** nome valido che spiega quello ricevuto. Se sono due o nessuno, il
//! nome resta com'è e la chiamata fallisce come prima — meglio un passo perso
//! che uno strumento chiamato al posto di un altro.

/// I nomi degli strumenti offerti in questa richiesta.
///
/// Si leggono dal corpo che stiamo per mandare al provider: sono l'unica
/// verità su cosa è lecito chiamare, e cambiano da una chiamata all'altra.
pub fn nomi_offerti(tools: Option<&Vec<serde_json::Value>>) -> Vec<String> {
    tools
        .map(|t| {
            t.iter()
                .filter_map(|v| {
                    v.pointer("/function/name")
                        .or_else(|| v.get("name"))
                        .and_then(|n| n.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Il nome vero dietro quello ricevuto, se se ne riconosce uno solo.
///
/// Restituisce `None` quando il nome è già valido, quando non somiglia a
/// niente, o quando somiglia a più di uno.
pub fn ripara(ricevuto: &str, offerti: &[String]) -> Option<String> {
    if offerti.iter().any(|n| n == ricevuto) {
        return None;
    }

    // Si tolgono i caratteri che non appartengono a un nome di strumento —
    // i nostri sono tutti minuscole, cifre e trattini bassi — e si guarda
    // cosa resta.
    let pulito: String = ricevuto
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    let nucleo = pulito.trim_matches('_');

    let candidati: Vec<&String> = offerti
        .iter()
        .filter(|valido| {
            // «_add_node» contiene «add_node»; «connect5c5e83b0c» comincia per
            // «connect». Entrambe le forme si sono viste davvero.
            nucleo == valido.as_str()
                || nucleo.starts_with(valido.as_str())
                || nucleo.contains(valido.as_str())
        })
        .collect();

    // Fra «connect» e «disconnect» vince il più lungo che spiega il nome: se
    // arrivasse «disconnect_x», scegliere «connect» sarebbe un errore grave —
    // scollegherebbe invece di collegare.
    let mut ordinati = candidati;
    ordinati.sort_by_key(|n| std::cmp::Reverse(n.len()));

    match ordinati.first() {
        Some(migliore) => {
            // Ambiguo solo se due candidati sono lunghi uguale: allora non c'è
            // modo di scegliere e non si sceglie.
            let pari = ordinati
                .iter()
                .filter(|n| n.len() == migliore.len())
                .count();
            if pari > 1 {
                None
            } else {
                Some((*migliore).clone())
            }
        }
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offerti() -> Vec<String> {
        [
            "analyze_goal",
            "search_nodes",
            "get_node_schema",
            "add_node",
            "delete_node",
            "connect",
            "disconnect",
            "set_config",
            "validate_workflow",
            "finish",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect()
    }

    #[test]
    fn un_nome_giusto_non_si_tocca() {
        assert_eq!(ripara("add_node", &offerti()), None);
        assert_eq!(ripara("finish", &offerti()), None);
    }

    #[test]
    fn i_casi_visti_davvero_si_riparano() {
        // Presi da una sessione vera del 2026-08-04.
        assert_eq!(ripara("_add_node", &offerti()).as_deref(), Some("add_node"));
        assert_eq!(
            ripara("connect5c5e83b0c", &offerti()).as_deref(),
            Some("connect")
        );
        assert_eq!(
            ripara("connect5c5e83b0cściół", &offerti()).as_deref(),
            Some("connect")
        );
    }

    #[test]
    fn niente_si_inventa_dal_nulla() {
        assert_eq!(ripara("manda_email", &offerti()), None);
        assert_eq!(ripara("", &offerti()), None);
        assert_eq!(ripara("xyz", &offerti()), None);
    }

    #[test]
    fn fra_due_che_si_somigliano_vince_il_piu_specifico() {
        // «disconnect» contiene «connect»: sporcarlo non deve trasformare uno
        // scollegamento in un collegamento.
        assert_eq!(
            ripara("disconnect_abc", &offerti()).as_deref(),
            Some("disconnect")
        );
    }

    #[test]
    fn senza_strumenti_offerti_non_si_ripara_niente() {
        assert_eq!(ripara("_add_node", &[]), None);
    }

    #[test]
    fn i_nomi_si_leggono_dal_corpo_della_richiesta() {
        let tools = vec![
            serde_json::json!({ "type": "function", "function": { "name": "add_node" } }),
            serde_json::json!({ "name": "connect" }),
        ];
        assert_eq!(nomi_offerti(Some(&tools)), vec!["add_node", "connect"]);
        assert!(nomi_offerti(None).is_empty());
    }
}

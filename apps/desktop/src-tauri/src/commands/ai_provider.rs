//! I provider AI che il backend sa chiamare.
//!
//! Il nome arriva dal frontend come stringa. Tenerlo stringa fino al punto in
//! cui si sceglie chi chiamare voleva dire che l'elenco dei provider esisteva
//! due volte — nel `match` qui e nel tipo TypeScript di là — e niente diceva
//! se le due copie coincidevano. Qui il nome diventa un tipo: il `match` che
//! instrada è esaustivo per costruzione, e un test confronta l'elenco con
//! quello del frontend.

/// Un provider raggiungibile via API dal backend.
///
/// Manca di proposito `claude-cli`: l'abbonamento non passa da qui ma dalla
/// CLI locale (`claude_cli_cmd`), che fa da sé autenticazione e ciclo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Custom,
    Anthropic,
    OpenAi,
    Gemini,
    DeepSeek,
    Grok,
    OpenRouter,
}

impl Provider {
    /// Tutti, nell'ordine in cui sono dichiarati.
    pub const TUTTI: [Provider; 7] = [
        Provider::Custom,
        Provider::Anthropic,
        Provider::OpenAi,
        Provider::Gemini,
        Provider::DeepSeek,
        Provider::Grok,
        Provider::OpenRouter,
    ];

    /// Il nome con cui il frontend lo chiama.
    pub fn nome(self) -> &'static str {
        match self {
            Provider::Custom => "custom",
            Provider::Anthropic => "anthropic",
            Provider::OpenAi => "openai",
            Provider::Gemini => "gemini",
            Provider::DeepSeek => "deepseek",
            Provider::Grok => "grok",
            Provider::OpenRouter => "openrouter",
        }
    }

    /// Il provider con quel nome, se esiste.
    pub fn da_nome(nome: &str) -> Option<Provider> {
        Provider::TUTTI.into_iter().find(|p| p.nome() == nome)
    }
}

#[cfg(test)]
mod tests {
    use super::Provider;

    /// L'elenco del frontend, letto dal suo sorgente: è quello vero, non una
    /// copia che qualcuno deve ricordarsi di aggiornare.
    const TIPI_FRONTEND: &str = include_str!("../../../src/features/ai/types.ts");

    /// I nomi dentro `export const PROVIDER_IDS = [ … ] as const`.
    fn provider_del_frontend() -> Vec<String> {
        let inizio = TIPI_FRONTEND
            .find("export const PROVIDER_IDS = [")
            .expect("types.ts non dichiara più PROVIDER_IDS: questo test va riallineato");
        let resto = &TIPI_FRONTEND[inizio..];
        let fine = resto
            .find("] as const")
            .expect("PROVIDER_IDS non è più un array `as const`");
        resto[..fine]
            .split('\'')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn il_test_sa_leggere_l_elenco_del_frontend() {
        // Se l'estrazione smettesse di funzionare, il confronto qui sotto
        // passerebbe confrontando il nulla con sé stesso.
        let nomi = provider_del_frontend();
        assert!(nomi.len() >= 2, "elenco letto: {nomi:?}");
        assert!(nomi.contains(&"claude-cli".to_string()));
    }

    #[test]
    fn frontend_e_backend_conoscono_gli_stessi_provider() {
        let mut dal_frontend: Vec<String> = provider_del_frontend()
            .into_iter()
            // L'abbonamento passa dalla CLI, non da questo instradamento.
            .filter(|n| n != "claude-cli")
            .collect();
        dal_frontend.sort();

        let mut dal_backend: Vec<String> = Provider::TUTTI
            .iter()
            .map(|p| p.nome().to_string())
            .collect();
        dal_backend.sort();

        assert_eq!(
            dal_frontend, dal_backend,
            "un provider offerto nel menu e non servito qui risponde «sconosciuto»; \
             uno servito qui e non offerto è codice che nessuno può raggiungere"
        );
    }

    #[test]
    fn ogni_nome_torna_al_suo_provider() {
        for p in Provider::TUTTI {
            assert_eq!(Provider::da_nome(p.nome()), Some(p));
        }
    }

    #[test]
    fn un_nome_che_non_esiste_non_diventa_un_provider() {
        assert_eq!(Provider::da_nome("provider-dismesso"), None);
        assert_eq!(Provider::da_nome(""), None);
        // L'abbonamento non è un provider di questo instradamento.
        assert_eq!(Provider::da_nome("claude-cli"), None);
    }
}

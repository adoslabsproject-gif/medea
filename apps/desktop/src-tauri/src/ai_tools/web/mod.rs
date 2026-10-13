//! Gli strumenti che portano l'assistente fuori dalla posta: cercare sul web
//! e aprire una pagina.
//!
//! Valgono per ogni modello, perché sono strumenti di Medea e non del
//! provider. Sono anche gli unici con cui l'assistente parla con l'esterno:
//! per questo tutto quello che esce passa da [`guardia`], e tutto quello che
//! entra arriva al modello dichiarato come testo di terzi.

pub mod fetch;
pub mod guardia;
pub mod search;
pub mod testo;

pub use fetch::web_fetch;
pub use search::web_search;

/// Come si presenta Medea ai siti: un browser qualunque. Molti siti
/// rispondono con una pagina vuota o un rifiuto a chi si dichiara un
/// programma.
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

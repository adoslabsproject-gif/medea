//! «Claude in abbonamento»: Claude Code dentro il pannello di Medea, con la
//! CLI `claude` installata sul computer al posto dell'API a consumo.
//!
//! Sei pezzi, ognuno provabile da solo:
//!
//!  - [`locate`] — dove sta la CLI, sistema per sistema;
//!  - [`args`] — con quali opzioni la si avvia, e perché ognuna;
//!  - [`workdir`] — i file che le servono per un turno, e dove stanno;
//!  - [`protocol`] — cosa le si scrive, e cosa di ciò che dice va al pannello;
//!  - [`events`] — il conto di un turno mentre la CLI lo racconta;
//!  - [`run`] — il turno intero: avvio, permessi, interruzione, risposta.
//!
//! I comandi Tauri che li espongono stanno in `commands::claude_cli_cmd`.

pub mod args;
pub mod events;
pub mod locate;
pub mod protocol;
pub mod run;
pub mod workdir;

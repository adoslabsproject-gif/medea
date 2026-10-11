//! «Claude in abbonamento»: la CLI `claude` installata sul computer, usata
//! come motore di ragionamento al posto dell'API a consumo.
//!
//! Cinque pezzi, ognuno provabile da solo:
//!
//!  - [`locate`] — dove sta la CLI, sistema per sistema;
//!  - [`args`] — con quali opzioni la si avvia, e perché ognuna;
//!  - [`workdir`] — i file che le servono per un turno, e dove stanno;
//!  - [`events`] — come si legge quello che risponde;
//!  - [`run`] — il turno intero, dall'avvio alla risposta.
//!
//! I comandi Tauri che li espongono stanno in `commands::claude_cli_cmd`.

pub mod args;
pub mod events;
pub mod locate;
pub mod run;
pub mod workdir;

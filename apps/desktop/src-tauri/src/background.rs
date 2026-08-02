//! Medea che resta al lavoro quando la finestra si chiude.
//!
//! Le automazioni girano dentro Medea: il motore è un processo figlio e muore
//! con lei. Finché chiudere la finestra voleva dire chiudere l'applicazione, un
//! cron delle otto del mattino funzionava soltanto se qualcuno si ricordava di
//! tenere aperta la finestra — cioè non era un'automazione.
//!
//! Qui la finestra si limita a sparire: l'applicazione resta, con la sua icona
//! nella barra di stato, e il motore continua a lavorare. Da quell'icona si
//! riapre la finestra o si esce davvero.
//!
//! **Solo quando serve.** Se non c'è nemmeno un workflow attivo, tenere in vita
//! un processo dopo che l'utente ha chiuso la finestra è un abuso: chiudere
//! chiude. Il comportamento si accende dalle impostazioni, ed è spento finché
//! non c'è qualcosa da tenere in vita.

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WindowEvent,
};

/// Il nome della finestra principale nella configurazione di Tauri.
const MAIN_WINDOW: &str = "main";

/// La chiave con cui la preferenza vive nel database.
pub const STAY_ALIVE_KEY: &str = "background_when_closed";

/// Se l'applicazione deve restare viva a finestra chiusa.
///
/// Lo decide chi usa Medea dalle impostazioni; il valore vive nel database,
/// così vale anche al riavvio successivo.
pub fn stays_alive_when_closed() -> bool {
    crate::db::settings::get_bool(STAY_ALIVE_KEY)
}

/// Costruisce l'icona nella barra di stato e il suo menu.
///
/// Il menu è deliberatamente povero — aprire e uscire. Una barra di stato che
/// diventa un secondo pannello di controllo è un posto dove le cose si
/// nascondono: le impostazioni stanno nell'applicazione, dove si cercano.
pub fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let apri = MenuItem::with_id(app, "apri", "Apri Medea", true, None::<&str>)?;
    let esci = MenuItem::with_id(app, "esci", "Esci", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&apri, &esci])?;

    TrayIconBuilder::with_id("medea-tray")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("icona dell'applicazione non disponibile".into())
        })?)
        .tooltip("Medea — le automazioni attive continuano a girare")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "apri" => show_main_window(app),
            "esci" => {
                // Uscita voluta: il motore si spegne con l'applicazione, come
                // deve. `exit` fa cadere lo stato e con lui il processo figlio.
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

/// Riporta in primo piano la finestra principale, ricreandola se non c'è più.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Intercetta la chiusura della finestra.
///
/// Quando Medea deve restare al lavoro, la richiesta di chiusura viene annullata
/// e la finestra soltanto nascosta. Altrimenti non si fa nulla e Tauri chiude
/// come sempre.
pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != MAIN_WINDOW {
        return;
    }

    if !stays_alive_when_closed() {
        return;
    }

    api.prevent_close();
    let _ = window.hide();
    tracing::info!("Finestra nascosta: le automazioni attive restano in funzione");
}

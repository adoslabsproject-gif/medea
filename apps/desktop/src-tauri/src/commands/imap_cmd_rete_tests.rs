//! Prove che vanno davvero in rete. Non girano con le altre: si lanciano a
//! mano, sulla macchina di cui si vuole sapere qualcosa.
//!
//!   cargo test --lib imap_cmd::rete -- --ignored --nocapture

use super::*;

/// Fin dove arriva il collegamento a Gmail con credenziali inventate.
///
/// Deve arrivare fino al rifiuto delle credenziali: vuol dire che rete, TLS
/// e protocollo funzionano, e che un «non prende la password» dipende dalla
/// password. Se invece si ferma prima — TCP o TLS — il difetto è della
/// macchina o del programma, e nessuna password potrà mai passare.
#[tokio::test]
#[ignore = "va in rete verso imap.gmail.com"]
async fn con_credenziali_inventate_gmail_rifiuta_il_login_e_non_il_collegamento() {
    let creds = ImapCredentials {
        host: "imap.gmail.com".into(),
        port: 993,
        // `.invalid` non può appartenere a nessuno (RFC 2606): un indirizzo
        // Gmail inventato potrebbe essere la casella di una persona vera.
        username: "nessuno@medea-prova.invalid".into(),
        password: "abcdefghijklmnop".into(),
        secure: true,
        accept_invalid_certs: false,
    };
    let errore = match open_session(&creds).await {
        Ok(_) => panic!("credenziali inventate accettate"),
        Err(e) => e.to_string(),
    };
    println!("ERRORE: {errore}");
    assert!(errore.contains("LOGIN IMAP fallito"), "{errore}");
}

//! Tauri commands — Fase 0 placeholder.
//!
//! Le commands reali (accounts, oauth, sync, messages, send, ai) arriveranno
//! in Fase 1+ e vivranno in moduli dedicati (`accounts.rs`, `messages.rs`,
//! `oauth.rs`, `sync.rs`, `ai.rs`, …). Per ora un solo `ping` per dimostrare
//! che il binding TS↔Rust funziona.

#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}

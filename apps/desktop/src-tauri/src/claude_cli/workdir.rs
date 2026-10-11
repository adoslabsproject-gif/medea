//! I file che servono alla CLI per un turno, e dove stanno.
//!
//! Stanno fra i dati dell'app e non nella cartella temporanea del sistema: lì
//! un altro utente della macchina potrebbe preparare un file con lo stesso
//! nome e far avviare alla CLI un programma suo.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// La cartella, dentro i dati dell'app, dove la CLI lavora.
const CARTELLA_LAVORO: &str = "claude-cli";

/// Crea la cartella di lavoro della CLI, leggibile solo dall'utente.
pub fn cartella_lavoro(data_dir: &Path) -> std::io::Result<PathBuf> {
    let dir = data_dir.join(CARTELLA_LAVORO);
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Un file che sparisce quando il turno finisce, comunque finisca.
///
/// Il prompt di sistema contiene le memorie dell'utente: non deve restare su
/// disco dopo che la CLI lo ha letto.
pub struct FileDelTurno(PathBuf);

impl FileDelTurno {
    pub fn scrivi(dir: &Path, contenuto: &str) -> std::io::Result<Self> {
        static PROGRESSIVO: AtomicU64 = AtomicU64::new(0);
        // Due turni possono correre insieme — la chat e una sintesi — e non
        // devono scriversi addosso.
        let nome = format!(
            "sistema-{}-{}.txt",
            std::process::id(),
            PROGRESSIVO.fetch_add(1, Ordering::Relaxed)
        );
        let path = dir.join(nome);
        std::fs::write(&path, contenuto)?;
        Ok(Self(path))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for FileDelTurno {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Una cartella di prova tutta sua, tolta alla fine.
    fn cartella_di_prova(nome: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("medea-{nome}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("cartella di prova");
        dir
    }

    #[test]
    fn il_file_del_turno_sparisce_quando_il_turno_finisce() {
        let dir = cartella_di_prova("sparisce");
        let path = {
            let file = FileDelTurno::scrivi(&dir, "memorie dell'utente").expect("file");
            assert_eq!(
                std::fs::read_to_string(file.path()).expect("lettura"),
                "memorie dell'utente"
            );
            file.path().to_path_buf()
        };
        assert!(!path.exists());
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn due_turni_insieme_non_condividono_il_file() {
        let dir = cartella_di_prova("due-turni");
        let a = FileDelTurno::scrivi(&dir, "a").expect("file");
        let b = FileDelTurno::scrivi(&dir, "b").expect("file");
        assert_ne!(a.path(), b.path());
        drop((a, b));
        let _ = std::fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn la_cartella_di_lavoro_e_leggibile_solo_dall_utente() {
        use std::os::unix::fs::PermissionsExt;
        let base = cartella_di_prova("permessi");
        let dir = cartella_lavoro(&base).expect("cartella");
        let mode = std::fs::metadata(&dir)
            .expect("metadati")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        let _ = std::fs::remove_dir(&dir);
        let _ = std::fs::remove_dir(&base);
    }
}

//! Dove sta la CLI `claude`.
//!
//! Un'app grafica non eredita il PATH del terminale — su macOS ne riceve uno
//! ridotto all'osso — quindi cercarla per nome non basta: si guardano prima i
//! posti in cui gli installatori la mettono, poi il PATH che c'è.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Quello che serve sapere del sistema per cercare la CLI.
///
/// È un dato e non una lettura diretta dell'ambiente perché così la ricerca
/// si può provare per Windows anche da un Mac.
#[derive(Debug, Clone, Default)]
pub struct Ambiente {
    /// La cartella dell'utente (`HOME`, o `USERPROFILE` su Windows).
    pub home: Option<PathBuf>,
    /// `APPDATA`, dove npm mette i programmi globali su Windows.
    pub appdata: Option<PathBuf>,
    /// Le cartelle del PATH ereditato.
    pub path: Vec<PathBuf>,
    pub windows: bool,
}

impl Ambiente {
    pub fn corrente() -> Self {
        let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
        Self {
            home: var("HOME")
                .or_else(|| var("USERPROFILE"))
                .map(PathBuf::from),
            appdata: var("APPDATA").map(PathBuf::from),
            path: var("PATH")
                .map(|p| std::env::split_paths(&p).collect())
                .unwrap_or_default(),
            windows: cfg!(windows),
        }
    }

    /// I nomi con cui la CLI può presentarsi in una cartella.
    fn nomi(&self) -> &'static [&'static str] {
        if self.windows {
            // L'eseguibile nativo prima del lanciatore di npm: è un programma
            // vero, non un file batch da far interpretare.
            &["claude.exe", "claude.cmd"]
        } else {
            &["claude"]
        }
    }

    /// Le cartelle in cui gli installatori mettono la CLI, dalla più probabile.
    pub fn cartelle_note(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Some(home) = &self.home {
            // L'installatore nativo, uguale su tutti i sistemi.
            out.push(home.join(".local").join("bin"));
        }
        if self.windows {
            if let Some(appdata) = &self.appdata {
                out.push(appdata.join("npm"));
            }
        } else {
            out.push(PathBuf::from("/opt/homebrew/bin"));
            out.push(PathBuf::from("/usr/local/bin"));
        }
        if let Some(home) = &self.home {
            if !self.windows {
                out.push(home.join(".claude").join("local"));
                out.push(home.join(".npm-global").join("bin"));
            }
            out.push(home.join(".bun").join("bin"));
        }
        out
    }

    /// Tutti i percorsi in cui la CLI può trovarsi, in ordine di preferenza.
    pub fn candidati(&self) -> Vec<PathBuf> {
        self.cartelle_note()
            .into_iter()
            .chain(self.path.iter().cloned())
            .flat_map(|dir| self.nomi().iter().map(move |nome| dir.join(nome)))
            .collect()
    }

    /// Il PATH da dare alla CLI: le cartelle note davanti a quello ereditato.
    ///
    /// La CLI avvia a sua volta altri programmi, e senza le cartelle note non
    /// li troverebbe per la stessa ragione per cui Medea non trova lei.
    pub fn path_esteso(&self) -> OsString {
        let mut dirs = self.cartelle_note();
        if !self.windows {
            dirs.push(PathBuf::from("/opt/homebrew/sbin"));
            if let Some(home) = &self.home {
                dirs.push(home.join(".cargo").join("bin"));
            }
        }
        dirs.extend(self.path.iter().cloned());
        // Una cartella con il separatore nel nome non si può esprimere nel
        // PATH: in quel caso si lascia quello ereditato com'è.
        std::env::join_paths(dirs)
            .or_else(|_| std::env::join_paths(self.path.iter()))
            .unwrap_or_default()
    }
}

/// Il primo candidato che esiste davvero, secondo `esiste`.
pub fn primo_esistente(ambiente: &Ambiente, esiste: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    ambiente.candidati().into_iter().find(|p| esiste(p))
}

/// La CLI su questo computer, se c'è.
pub fn locate() -> Option<PathBuf> {
    primo_esistente(&Ambiente::corrente(), Path::is_file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mac() -> Ambiente {
        Ambiente {
            home: Some(PathBuf::from("/Users/anna")),
            appdata: None,
            path: vec![PathBuf::from("/usr/bin")],
            windows: false,
        }
    }

    fn windows() -> Ambiente {
        Ambiente {
            home: Some(PathBuf::from("C:/Users/anna")),
            appdata: Some(PathBuf::from("C:/Users/anna/AppData/Roaming")),
            path: vec![PathBuf::from("C:/strumenti")],
            windows: true,
        }
    }

    #[test]
    fn su_mac_e_linux_guarda_l_installatore_nativo_per_primo() {
        let candidati = mac().candidati();
        assert_eq!(candidati[0], PathBuf::from("/Users/anna/.local/bin/claude"));
        assert!(candidati.contains(&PathBuf::from("/opt/homebrew/bin/claude")));
    }

    /// Su Windows non esiste `HOME` e la CLI non si chiama `claude`: cercarla
    /// come su Mac significava non trovarla mai.
    #[test]
    fn su_windows_cerca_l_eseguibile_e_il_lanciatore_di_npm() {
        let candidati = windows().candidati();
        assert_eq!(
            candidati[0],
            PathBuf::from("C:/Users/anna/.local/bin/claude.exe")
        );
        assert!(candidati.contains(&PathBuf::from(
            "C:/Users/anna/AppData/Roaming/npm/claude.cmd"
        )));
        assert!(candidati
            .iter()
            .all(|p| p.extension().is_some_and(|e| e == "exe" || e == "cmd")));
        assert!(!candidati.iter().any(|p| p.starts_with("/opt/homebrew")));
    }

    #[test]
    fn un_installazione_fuori_dai_posti_noti_si_trova_dal_path() {
        let ambiente = windows();
        let altrove = PathBuf::from("C:/strumenti/claude.exe");
        let trovata = primo_esistente(&ambiente, |p| p == altrove);
        assert_eq!(trovata, Some(altrove));
    }

    #[test]
    fn fra_due_installazioni_vince_quella_dell_installatore_nativo() {
        let ambiente = mac();
        let trovata = primo_esistente(&ambiente, |p| {
            p == Path::new("/usr/bin/claude") || p == Path::new("/Users/anna/.local/bin/claude")
        });
        assert_eq!(
            trovata,
            Some(PathBuf::from("/Users/anna/.local/bin/claude"))
        );
    }

    #[test]
    fn senza_niente_installato_non_trova_niente() {
        assert_eq!(primo_esistente(&mac(), |_| false), None);
    }

    #[test]
    fn il_path_esteso_mette_le_cartelle_note_davanti_a_quello_ereditato() {
        let esteso = mac().path_esteso();
        let dirs: Vec<PathBuf> = std::env::split_paths(&esteso).collect();
        let nota = dirs
            .iter()
            .position(|d| d == Path::new("/Users/anna/.local/bin"))
            .expect("la cartella nota");
        let ereditata = dirs
            .iter()
            .position(|d| d == Path::new("/usr/bin"))
            .expect("la cartella ereditata");
        assert!(nota < ereditata);
    }

    #[test]
    fn senza_cartella_utente_resta_il_path_ereditato() {
        let ambiente = Ambiente {
            home: None,
            appdata: None,
            path: vec![PathBuf::from("/usr/bin")],
            windows: false,
        };
        assert!(ambiente
            .candidati()
            .contains(&PathBuf::from("/usr/bin/claude")));
    }
}

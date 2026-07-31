//! Scanner di sicurezza per allegati email.
//!
//! Filosofia: metadata-only, zero I/O. Analizza nome, MIME, dimensioni e (opzionale)
//! primi byte (magic header) per classificare ogni allegato in tre livelli:
//!
//!   - `Safe`     → estensione comune sicura (pdf, jpg, txt, png, ecc.)
//!   - `Caution`  → potenzialmente rischioso, va aperto solo se attendibile
//!     (archivi, macro Office, html, iso, immagini disco, doppia ext lieve)
//!   - `Danger`   → eseguibile o pattern di phishing/spoofing tipico
//!
//! Restituisce sempre un `ThreatReport` con `reasons` (perché) e `suggestions`
//! (come mitigare). La UI mostra entrambi nel modal di warning.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreatLevel {
    Safe,
    Caution,
    Danger,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreatReport {
    pub level: ThreatLevel,
    pub reasons: Vec<String>,
    pub suggestions: Vec<String>,
    pub category: String, // human-readable: "Eseguibile Windows", "PDF", "Archivio"
    pub icon: String,     // emoji
    pub sha256_hex: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentEntry {
    pub index: usize,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: u64,
    pub is_inline: bool,
    pub threat: ThreatReport,
}

/// Estensioni eseguibili: aprirle = quasi sempre malware su mail.
const EXEC_EXTS: &[&str] = &[
    "exe",
    "scr",
    "bat",
    "com",
    "cmd",
    "vbs",
    "vbe",
    "js",
    "jse",
    "ws",
    "wsh",
    "wsf",
    "ps1",
    "psm1",
    "psd1",
    "msi",
    "msp",
    "mst",
    "msc",
    "cpl",
    "reg",
    "lnk",
    "pif",
    "scf",
    "inf",
    "hta",
    "gadget",
    "jar",
    "appx",
    "appxbundle",
    "app",
    "dmg",
    "pkg",
    "deb",
    "rpm",
    "apk",
    "ipa",
    "sh",
    "bash",
    "zsh",
    "ksh",
    "csh",
    "fish",
    "py",
    "pyc",
    "rb",
    "pl",
    "php",
    "dll",
    "so",
    "dylib",
    "sys",
];

/// Documenti Office con macro abilitate.
const MACRO_EXTS: &[&str] = &[
    "docm", "dotm", "xlsm", "xlsb", "xltm", "xlam", "pptm", "potm", "ppam", "ppsm", "sldm",
];

/// Archivi: possono contenere eseguibili.
const ARCHIVE_EXTS: &[&str] = &[
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "tbz2", "lz", "lzma", "cab", "ace", "arj",
    "z",
];

/// Image-disk / container: spesso usati per bypassare gli AV.
const DISK_EXTS: &[&str] = &["iso", "img", "vhd", "vhdx", "vmdk"];

/// Tipi che ammettono richiamo a script remoti.
const WEB_EXTS: &[&str] = &[
    "html", "htm", "xhtml", "shtml", "xml", "svg", "mht", "mhtml", "url",
];

/// Documenti generalmente sicuri.
const DOC_EXTS_SAFE: &[&str] = &[
    "pdf", "txt", "rtf", "csv", "tsv", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
    "odp", "md", "log",
];

const IMAGE_EXTS_SAFE: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif", "heic", "heif", "avif", "ico",
];

const MEDIA_EXTS_SAFE: &[&str] = &[
    "mp3", "wav", "flac", "ogg", "aac", "m4a", "mp4", "m4v", "mov", "mkv", "webm", "avi",
];

fn ext_of(name: &str) -> String {
    name.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
}

fn all_exts(name: &str) -> Vec<String> {
    name.split('.')
        .skip(1)
        .map(|p| p.to_ascii_lowercase())
        .collect()
}

fn is_in(set: &[&str], ext: &str) -> bool {
    set.contains(&ext)
}

fn category_for(ext: &str) -> (&'static str, &'static str) {
    if is_in(EXEC_EXTS, ext) {
        match ext {
            "exe" | "scr" | "bat" | "cmd" | "com" | "msi" | "ps1" => ("Eseguibile Windows", "💀"),
            "app" | "dmg" | "pkg" => ("Eseguibile macOS", "💀"),
            "deb" | "rpm" | "sh" | "bash" => ("Eseguibile Linux", "💀"),
            "apk" | "ipa" => ("App mobile", "💀"),
            "dll" | "so" | "dylib" | "sys" => ("Libreria nativa", "💀"),
            "jar" => ("Applicazione Java", "💀"),
            _ => ("Script eseguibile", "💀"),
        }
    } else if is_in(MACRO_EXTS, ext) {
        ("Documento Office con macro", "⚠️")
    } else if is_in(ARCHIVE_EXTS, ext) {
        ("Archivio compresso", "📦")
    } else if is_in(DISK_EXTS, ext) {
        ("Immagine disco", "💿")
    } else if is_in(WEB_EXTS, ext) {
        ("Pagina web / HTML", "🌐")
    } else if is_in(DOC_EXTS_SAFE, ext) {
        match ext {
            "pdf" => ("PDF", "📄"),
            "txt" | "log" | "md" => ("Testo", "📝"),
            "csv" | "tsv" => ("Dati tabellari", "📊"),
            _ => ("Documento Office", "📄"),
        }
    } else if is_in(IMAGE_EXTS_SAFE, ext) {
        ("Immagine", "🖼")
    } else if is_in(MEDIA_EXTS_SAFE, ext) {
        ("Media", "🎬")
    } else {
        ("Sconosciuto", "❓")
    }
}

/// Detect spoofing tipico: `Fattura.pdf.exe`, `DHL_tracking.zip`, ecc.
fn check_double_extension(name: &str, last_ext: &str) -> Option<String> {
    let parts = all_exts(name);
    if parts.len() < 2 {
        return None;
    }
    let pre_last = &parts[parts.len().saturating_sub(2)];
    let common_doc =
        is_in(DOC_EXTS_SAFE, pre_last) || is_in(IMAGE_EXTS_SAFE, pre_last) || pre_last == "txt";
    if common_doc && is_in(EXEC_EXTS, last_ext) {
        return Some(format!(
            "Doppia estensione sospetta: il file finge di essere '.{pre_last}' ma è in realtà '.{last_ext}'."
        ));
    }
    None
}

/// Detect lure name (Fattura, DHL, Amazon, ecc.) abbinato a archivio o eseguibile.
fn check_lure_name(name: &str, ext: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let lures = [
        "fattura",
        "invoice",
        "ricevuta",
        "receipt",
        "ordine",
        "order",
        "dhl",
        "ups",
        "fedex",
        "tnt",
        "bartolini",
        "brt",
        "gls",
        "poste",
        "amazon",
        "tracking",
        "spedizione",
        "pagamento",
        "payment",
        "remittance",
        "bonifico",
        "verifica",
        "verify",
        "account",
        "password",
        "documento",
        "scansione",
        "scan",
    ];
    let hits: Vec<&str> = lures
        .iter()
        .copied()
        .filter(|l| lower.contains(l))
        .collect();
    if !hits.is_empty()
        && (is_in(EXEC_EXTS, ext) || is_in(ARCHIVE_EXTS, ext) || is_in(DISK_EXTS, ext))
    {
        return Some(format!(
            "Nome attira-click ({}) abbinato a tipo {} — pattern tipico di phishing.",
            hits.join(", "),
            if is_in(EXEC_EXTS, ext) {
                "eseguibile"
            } else if is_in(DISK_EXTS, ext) {
                "immagine disco"
            } else {
                "archivio"
            }
        ));
    }
    None
}

/// Detect MIME mismatch tra `Content-Type` dichiarato e estensione.
fn check_mime_mismatch(content_type: &str, ext: &str) -> Option<String> {
    let ct = content_type.to_ascii_lowercase();
    // Heuristic minime ma utili.
    let claims_pdf = ct.contains("application/pdf");
    let claims_image = ct.starts_with("image/");
    let claims_text = ct.starts_with("text/");
    let claims_zip = ct.contains("application/zip") || ct.contains("x-zip");

    if claims_pdf && ext != "pdf" && !ext.is_empty() {
        return Some(format!(
            "MIME dichiara 'application/pdf' ma estensione è '.{ext}'."
        ));
    }
    if claims_image && !is_in(IMAGE_EXTS_SAFE, ext) && !ext.is_empty() {
        return Some(format!("MIME dichiara immagine ma estensione è '.{ext}'."));
    }
    if claims_text && (is_in(EXEC_EXTS, ext) || is_in(ARCHIVE_EXTS, ext)) {
        return Some(format!("MIME dichiara testo ma estensione è '.{ext}'."));
    }
    if claims_zip && ext != "zip" && !ext.is_empty() {
        return Some(format!("MIME dichiara ZIP ma estensione è '.{ext}'."));
    }
    None
}

/// Magic-byte sniff per i primi byte (se disponibili). Solo segnali forti.
fn check_magic(head: &[u8]) -> Option<String> {
    if head.len() >= 2 && head[0] == 0x4D && head[1] == 0x5A {
        return Some("Magic byte 'MZ' = eseguibile Windows PE.".into());
    }
    if head.len() >= 4 && &head[..4] == b"\x7FELF" {
        return Some("Magic byte ELF = eseguibile Linux.".into());
    }
    if head.len() >= 4
        && (&head[..4] == b"\xCE\xFA\xED\xFE"
            || &head[..4] == b"\xCF\xFA\xED\xFE"
            || &head[..4] == b"\xFE\xED\xFA\xCE"
            || &head[..4] == b"\xFE\xED\xFA\xCF")
    {
        return Some("Magic byte Mach-O = eseguibile macOS.".into());
    }
    None
}

/// Hash SHA-256 (per check manuale su VirusTotal).
fn sha256_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// Analizza un allegato dai suoi metadati. Se `bytes` è fornito, esegue
/// anche magic-byte sniff e calcola SHA-256.
pub fn analyze(
    filename: &str,
    content_type: &str,
    size_bytes: u64,
    bytes: Option<&[u8]>,
) -> ThreatReport {
    let safe_name = if filename.trim().is_empty() {
        "(senza nome)"
    } else {
        filename
    };
    let ext = ext_of(safe_name);
    let (category, icon) = category_for(&ext);
    let mut reasons: Vec<String> = Vec::new();
    let mut suggestions: Vec<String> = Vec::new();

    // 1) Classificazione di base sull'estensione.
    let mut level = if is_in(EXEC_EXTS, &ext) {
        reasons.push(format!("Estensione '.{ext}' è un eseguibile/script."));
        suggestions.push(
            "NON aprire. Gli eseguibili via email sono il vettore numero 1 di malware.".into(),
        );
        ThreatLevel::Danger
    } else if is_in(MACRO_EXTS, &ext) {
        reasons.push(format!(
            "Estensione '.{ext}' = documento Office con macro VBA."
        ));
        suggestions.push(
            "Apri solo se atteso da un mittente fidato; disabilita le macro all'apertura.".into(),
        );
        ThreatLevel::Caution
    } else if is_in(DISK_EXTS, &ext) {
        reasons.push(format!(
            "Estensione '.{ext}' = immagine disco, usata per bypassare l'antimalware."
        ));
        suggestions.push("Non montare se il mittente non è chiaramente atteso.".into());
        ThreatLevel::Caution
    } else if is_in(ARCHIVE_EXTS, &ext) {
        reasons.push(format!(
            "Estensione '.{ext}' = archivio compresso (può contenere eseguibili)."
        ));
        suggestions.push(
            "Apri solo se atteso; scansiona il contenuto prima di eseguire qualunque cosa.".into(),
        );
        ThreatLevel::Caution
    } else if is_in(WEB_EXTS, &ext) {
        reasons.push(format!(
            "Estensione '.{ext}' = pagina web (può richiamare risorse remote / fingere un login)."
        ));
        suggestions.push("Apri solo in un browser, mai dal client mail.".into());
        ThreatLevel::Caution
    } else if is_in(DOC_EXTS_SAFE, &ext)
        || is_in(IMAGE_EXTS_SAFE, &ext)
        || is_in(MEDIA_EXTS_SAFE, &ext)
    {
        ThreatLevel::Safe
    } else if ext.is_empty() {
        reasons.push("File senza estensione: tipo sconosciuto.".into());
        suggestions.push("Verifica con il mittente prima di aprire.".into());
        ThreatLevel::Caution
    } else {
        reasons.push(format!("Estensione '.{ext}' non riconosciuta."));
        suggestions.push("Tipo non in whitelist: verifica con il mittente.".into());
        ThreatLevel::Caution
    };

    // 2) Doppia estensione (`Fattura.pdf.exe`).
    if let Some(r) = check_double_extension(safe_name, &ext) {
        reasons.push(r);
        suggestions.push(
            "Mai aprire file con doppia estensione: è il pattern classico di un trojan.".into(),
        );
        level = ThreatLevel::Danger;
    }

    // 3) Nome lure abbinato a tipo pericoloso.
    if let Some(r) = check_lure_name(safe_name, &ext) {
        reasons.push(r);
        if matches!(level, ThreatLevel::Safe) {
            level = ThreatLevel::Caution;
        }
        if is_in(EXEC_EXTS, &ext) {
            level = ThreatLevel::Danger;
        }
    }

    // 4) MIME mismatch.
    if let Some(r) = check_mime_mismatch(content_type, &ext) {
        reasons.push(r);
        if matches!(level, ThreatLevel::Safe) {
            level = ThreatLevel::Caution;
        }
    }

    // 5) Magic-byte sniff (se ho bytes).
    let sha256 = bytes.map(sha256_of);
    if let Some(head) = bytes.map(|b| &b[..b.len().min(16)]) {
        if let Some(r) = check_magic(head) {
            reasons.push(r);
            level = ThreatLevel::Danger;
            suggestions.push("Magic byte conferma eseguibile nativo: pericolo concreto.".into());
        }
    }

    // 5b) Deep content scan (PDF JS, macro VBA nascoste, zip-bomb, ecc.)
    if let Some(b) = bytes {
        for f in deep_scan(safe_name, b) {
            reasons.push(f);
            // Findings di deep scan elevano sempre almeno a Caution.
            if matches!(level, ThreatLevel::Safe) {
                level = ThreatLevel::Caution;
            }
        }
        // Se troviamo JavaScript/Launch nel PDF, alzo a Danger.
        if reasons.iter().any(|r| {
            r.contains("JavaScript")
                || r.contains("OpenAction")
                || r.contains("Launch")
                || r.contains("vbaProject")
                || r.contains("macroSheets")
                || r.contains("zip-bomb")
        }) {
            level = ThreatLevel::Danger;
            suggestions.push(
                "Contenuto attivo rilevato dentro il file: alto rischio di payload nascosto."
                    .into(),
            );
        }
    }

    // 6) Filename con caratteri unicode invisibili (RLO/LRO, zero-width).
    if has_invisible_chars(safe_name) {
        reasons.push("Nome file contiene caratteri Unicode invisibili (RLO/zero-width) — tecnica di spoofing.".into());
        suggestions.push("Diffida: il nome visibile può differire dal nome reale.".into());
        if matches!(level, ThreatLevel::Safe) {
            level = ThreatLevel::Caution;
        }
    }

    // 7) Dimensione anomala.
    if size_bytes == 0 {
        reasons.push("Allegato a dimensione zero: probabile placeholder o file corrotto.".into());
        if matches!(level, ThreatLevel::Safe) {
            level = ThreatLevel::Caution;
        }
    }

    if suggestions.is_empty() && matches!(level, ThreatLevel::Safe) {
        suggestions.push("Nessuna anomalia rilevata.".into());
    }

    ThreatReport {
        level,
        reasons,
        suggestions,
        category: category.into(),
        icon: icon.into(),
        sha256_hex: sha256,
    }
}

fn has_invisible_chars(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(
            c,
            '\u{202A}'
                | '\u{202B}'
                | '\u{202C}'
                | '\u{202D}'
                | '\u{202E}'
                | '\u{200B}'
                | '\u{200C}'
                | '\u{200D}'
                | '\u{FEFF}'
        )
    })
}

// ── DEEP CONTENT SCAN ──────────────────────────────────────────────────────
//
// `analyze()` lavora su metadati + magic byte head. `deep_scan()` ispeziona
// l'intero blob alla ricerca di:
//
//   - PDF `/JavaScript` / `/JS` action (PDF JS exploit)
//   - PDF `/OpenAction` / `/Launch` (esecuzione di programmi esterni)
//   - DOCX / XLSX / PPTX con `vbaProject.bin` (macro VBA NASCOSTE in file
//     che si dichiarano «no macro» tramite estensione `.docx` invece di `.docm`)
//   - Zip-bomb (rapporto compressed/uncompressed > 100×)
//   - Allegato sproporzionato (`> 50 MB` → soglia per il read_text dell'AI)

const MAX_INSPECT_SIZE: u64 = 50 * 1024 * 1024;

/// Ispeziona profondamente il contenuto e ritorna findings da AGGIUNGERE a un
/// `ThreatReport` già ottenuto da `analyze()`. Vuoto se niente di sospetto.
pub fn deep_scan(filename: &str, bytes: &[u8]) -> Vec<String> {
    let mut findings = Vec::new();
    let ext = ext_of(filename);

    if bytes.len() as u64 > MAX_INSPECT_SIZE {
        findings.push(format!(
            "Allegato > {} MB: ispezione profonda saltata (potenziale DoS).",
            MAX_INSPECT_SIZE / 1024 / 1024
        ));
        return findings;
    }

    // PDF deep scan
    if ext == "pdf" || is_pdf_signature(bytes) {
        findings.extend(scan_pdf(bytes));
    }

    // Office / archivi ZIP-based
    if matches!(
        ext.as_str(),
        "docx"
            | "docm"
            | "xlsx"
            | "xlsm"
            | "pptx"
            | "pptm"
            | "odt"
            | "ods"
            | "odp"
            | "zip"
            | "epub"
    ) || is_zip_signature(bytes)
    {
        findings.extend(scan_zip(bytes));
    }

    // SVG con script embedded (SVG può contenere <script>)
    if ext == "svg" {
        if contains_ignore_case(bytes, b"<script") {
            findings.push(
                "SVG contiene <script>: può eseguire JavaScript se aperto in browser.".into(),
            );
        }
        if contains_ignore_case(bytes, b"javascript:") {
            findings.push("SVG contiene 'javascript:' URI scheme.".into());
        }
    }

    findings
}

fn is_pdf_signature(b: &[u8]) -> bool {
    b.len() >= 5 && &b[..5] == b"%PDF-"
}

fn is_zip_signature(b: &[u8]) -> bool {
    b.len() >= 4 && b[0] == 0x50 && b[1] == 0x4B && (b[2] == 0x03 || b[2] == 0x05 || b[2] == 0x07)
}

fn scan_pdf(bytes: &[u8]) -> Vec<String> {
    let mut findings = Vec::new();
    // PDF non compressi/parzialmente — i marker sono ASCII anche se gli stream
    // sono binari. Cerchiamo i pattern indicatori di azioni eseguibili.
    let mut counters: Vec<(&str, &str)> = vec![
        (
            "/JavaScript",
            "JavaScript embedded (rischio exploit reader)",
        ),
        ("/JS", "Riferimento JS abbreviato"),
        (
            "/OpenAction",
            "OpenAction (codice eseguito automaticamente all'apertura)",
        ),
        ("/Launch", "Launch action (può lanciare programmi esterni)"),
        ("/SubmitForm", "Submit form remota (può esfiltrare dati)"),
        ("/EmbeddedFile", "File embedded all'interno del PDF"),
        ("/RichMedia", "RichMedia / Flash (CVE notori)"),
    ];
    counters.retain(|(needle, _)| contains_bytes(bytes, needle.as_bytes()));
    for (_, label) in &counters {
        findings.push(format!("PDF: {label}."));
    }
    findings
}

fn scan_zip(bytes: &[u8]) -> Vec<String> {
    let mut findings = Vec::new();
    let Ok(mut zip) = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())) else {
        return findings;
    };

    let mut has_vba = false;
    let mut has_xl_macro = false;
    let mut has_embedded_exec = false;
    let mut total_uncompressed: u64 = 0;
    let total_compressed: u64 = bytes.len() as u64;
    let mut external_link = false;

    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index(i) else { continue };
        let name = entry.name().to_lowercase();
        total_uncompressed = total_uncompressed.saturating_add(entry.size());

        if name.ends_with("vbaproject.bin") {
            has_vba = true;
        }
        if name.contains("vbaproject") {
            has_vba = true;
        }
        if name.contains("macros/") {
            has_vba = true;
        }
        if name.contains("xl/macrosheets/") {
            has_xl_macro = true;
        }
        if name.ends_with(".exe")
            || name.ends_with(".dll")
            || name.ends_with(".scr")
            || name.ends_with(".bat")
            || name.ends_with(".cmd")
            || name.ends_with(".vbs")
            || name.ends_with(".ps1")
            || name.ends_with(".js")
        {
            has_embedded_exec = true;
        }
        if name.ends_with("externallinks.xml") || name.contains("externallinks/") {
            external_link = true;
        }
    }

    if has_vba {
        findings.push("Documento Office contiene `vbaProject.bin` → macro VBA presenti (anche se l'estensione non è .docm/.xlsm).".into());
    }
    if has_xl_macro {
        findings.push("Excel: presenza di `xl/macroSheets/` (foglio macro Excel 4.0 — vettore d'attacco classico).".into());
    }
    if has_embedded_exec {
        findings.push("L'archivio contiene file con estensione eseguibile al suo interno.".into());
    }
    if external_link {
        findings.push("Office: link a fonti esterne (externalLinks) — possibile esfiltrazione/template injection.".into());
    }
    if total_compressed > 0 {
        let ratio = total_uncompressed as f64 / total_compressed as f64;
        if ratio > 100.0 && total_uncompressed > 100 * 1024 * 1024 {
            findings.push(format!(
                "Rapporto compressione anomalo ({ratio:.0}×, {} MB espansi): possibile zip-bomb.",
                total_uncompressed / 1024 / 1024
            ));
        }
    }
    findings
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn contains_ignore_case(haystack: &[u8], needle_lower: &[u8]) -> bool {
    // confronto naïf, ok per pattern ASCII case-insensitive
    haystack.windows(needle_lower.len()).any(|w| {
        w.iter()
            .zip(needle_lower.iter())
            .all(|(a, b)| a.to_ascii_lowercase() == *b)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_is_danger() {
        let r = analyze("setup.exe", "application/octet-stream", 1024, None);
        assert!(matches!(r.level, ThreatLevel::Danger));
    }

    #[test]
    fn pdf_is_safe() {
        let r = analyze("fattura.pdf", "application/pdf", 50_000, None);
        assert!(matches!(r.level, ThreatLevel::Safe));
    }

    #[test]
    fn double_ext_is_danger() {
        let r = analyze("Fattura.pdf.exe", "application/octet-stream", 1024, None);
        assert!(matches!(r.level, ThreatLevel::Danger));
        assert!(r.reasons.iter().any(|s| s.contains("Doppia estensione")));
    }

    #[test]
    fn macro_doc_is_caution() {
        let r = analyze(
            "budget.xlsm",
            "application/vnd.ms-excel.sheet.macroEnabled.12",
            9000,
            None,
        );
        assert!(matches!(r.level, ThreatLevel::Caution));
    }

    #[test]
    fn zip_with_lure_name_is_caution() {
        let r = analyze("DHL_Tracking.zip", "application/zip", 10_000, None);
        assert!(matches!(r.level, ThreatLevel::Caution));
        assert!(r.reasons.iter().any(|s| s.contains("attira-click")));
    }

    #[test]
    fn mz_magic_is_danger() {
        let r = analyze("doc.pdf", "application/pdf", 2048, Some(b"MZ\x90\x00..."));
        assert!(matches!(r.level, ThreatLevel::Danger));
    }
}

//! Estrazione testo da allegati per AI.
//!
//! Supporta:
//!  - PDF (via `pdf-extract`)
//!  - TXT / CSV / TSV / MD / LOG (raw UTF-8)
//!  - HTML / XML (strip tags base)
//!  - XLSX / XLS (via `calamine`)
//!  - DOCX (manuale: zip + parse `word/document.xml`)
//!
//! Tutto in memoria, niente file temporanei.

use anyhow::{anyhow, Result};

pub fn extract_text(filename: &str, bytes: &[u8]) -> Result<String> {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "pdf"  => extract_pdf(bytes),
        "txt" | "csv" | "tsv" | "md" | "log" | "ini" | "yaml" | "yml" | "json" =>
            extract_utf8(bytes),
        "html" | "htm" | "xhtml" | "xml" => extract_html(bytes),
        "xlsx" | "xls" | "ods" => extract_spreadsheet(bytes, &ext),
        "docx" => extract_docx(bytes),
        other => Err(anyhow!("Formato '.{other}' non supportato per estrazione testo (passa al provider AI con vision se è immagine).")),
    }
}

fn extract_pdf(bytes: &[u8]) -> Result<String> {
    pdf_extract::extract_text_from_mem(bytes).map_err(|e| anyhow!("PDF parse fallito: {e}"))
}

fn extract_utf8(bytes: &[u8]) -> Result<String> {
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

fn extract_html(bytes: &[u8]) -> Result<String> {
    let raw = String::from_utf8_lossy(bytes);
    // Strip tag base. Non è una sanitizzazione di sicurezza (qui serve solo
    // dare al modello testo pulito).
    let no_scripts = regex_replace(&raw, r"(?is)<script[^>]*>.*?</script>", "");
    let no_styles = regex_replace(&no_scripts, r"(?is)<style[^>]*>.*?</style>", "");
    let no_tags = regex_replace(&no_styles, r"(?s)<[^>]+>", " ");
    let decoded = decode_entities(&no_tags);
    let collapsed = regex_replace(&decoded, r"\s+", " ");
    Ok(collapsed.trim().to_string())
}

fn extract_spreadsheet(bytes: &[u8], ext: &str) -> Result<String> {
    use calamine::{open_workbook_auto_from_rs, Data, Reader};
    use std::io::Cursor;
    let cursor = Cursor::new(bytes.to_vec());
    let mut wb = open_workbook_auto_from_rs(cursor)
        .map_err(|e| anyhow!("Spreadsheet parse fallito ({ext}): {e}"))?;
    let mut out = String::new();
    for sheet_name in wb.sheet_names().clone() {
        let range = wb
            .worksheet_range(&sheet_name)
            .map_err(|e| anyhow!("Sheet '{sheet_name}' lettura fallita: {e}"))?;
        out.push_str(&format!("\n=== Foglio: {sheet_name} ===\n"));
        for row in range.rows() {
            let cells: Vec<String> = row
                .iter()
                .map(|c| match c {
                    Data::String(s) => s.clone(),
                    Data::Int(i) => i.to_string(),
                    Data::Float(f) => format!("{f}"),
                    Data::Bool(b) => b.to_string(),
                    Data::DateTime(d) => d.to_string(),
                    Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
                    Data::Empty | Data::Error(_) => "".into(),
                })
                .collect();
            if cells.iter().any(|c| !c.is_empty()) {
                out.push_str(&cells.join("\t"));
                out.push('\n');
            }
        }
    }
    Ok(out)
}

fn extract_docx(bytes: &[u8]) -> Result<String> {
    use std::io::{Cursor, Read};
    let cursor = Cursor::new(bytes.to_vec());
    let mut zip =
        zip::ZipArchive::new(cursor).map_err(|e| anyhow!("DOCX non è uno ZIP valido: {e}"))?;
    let mut document_xml = String::new();
    {
        let mut entry = zip
            .by_name("word/document.xml")
            .map_err(|e| anyhow!("DOCX: word/document.xml mancante: {e}"))?;
        entry
            .read_to_string(&mut document_xml)
            .map_err(|e| anyhow!("DOCX read fallito: {e}"))?;
    }
    // Estraggo SOLO il contenuto dei tag <w:t> (Word paragraphs).
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;
    let mut reader = Reader::from_str(&document_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut in_w_t = false;
    let mut out = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.name();
                if name.as_ref() == b"w:t" {
                    in_w_t = true;
                }
                if name.as_ref() == b"w:p" || name.as_ref() == b"w:br" {
                    out.push('\n');
                }
            }
            Ok(Event::End(e)) => {
                if e.name().as_ref() == b"w:t" {
                    in_w_t = false;
                }
                if e.name().as_ref() == b"w:p" {
                    out.push('\n');
                }
            }
            Ok(Event::Text(t)) if in_w_t => {
                if let Ok(s) = t.unescape() {
                    out.push_str(&s);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow!("DOCX XML parse: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

// ── helpers (senza dipendenza da regex crate, basta sostituzione semplice via
//    iteratore — qui usiamo una funzione naive ma sufficiente per gli usi) ──

fn regex_replace(input: &str, pattern: &str, replace: &str) -> String {
    // Mini-regex emulator: solo i pattern che usiamo (con flag i/s, alternazione semplice)
    // Per evitare crate `regex`, sfruttiamo un parser ad-hoc. Per gli usi
    // limitati sopra (script/style/tag) è ok una sostituzione manuale.
    match pattern {
        r"(?is)<script[^>]*>.*?</script>" => strip_block_ci(input, "<script", "</script>"),
        r"(?is)<style[^>]*>.*?</style>" => strip_block_ci(input, "<style", "</style>"),
        r"(?s)<[^>]+>" => strip_tags(input),
        r"\s+" => collapse_ws(input, replace),
        _ => input.to_string(),
    }
}

fn strip_block_ci(input: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        let li = rest.to_lowercase();
        let oi = li.find(&open.to_lowercase());
        let Some(oi) = oi else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..oi]);
        let after_open = &rest[oi..];
        let li2 = after_open.to_lowercase();
        match li2.find(&close.to_lowercase()) {
            Some(ci) => rest = &after_open[ci + close.len()..],
            None => break,
        }
    }
    out
}

fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' if in_tag => {
                in_tag = false;
            }
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn collapse_ws(input: &str, repl: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_ws = false;
    for ch in input.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push_str(repl);
                prev_ws = true;
            }
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out
}

fn decode_entities(input: &str) -> String {
    input
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_works() {
        let r = extract_text("note.txt", b"Hello\nWorld").unwrap();
        assert_eq!(r, "Hello\nWorld");
    }

    #[test]
    fn html_strips_tags() {
        let r = extract_text(
            "page.html",
            b"<html><body><p>Ciao <b>mondo</b></p><script>x</script></body></html>",
        )
        .unwrap();
        assert!(r.contains("Ciao"));
        assert!(r.contains("mondo"));
        assert!(!r.contains("script"));
    }

    #[test]
    fn unsupported_returns_error() {
        let r = extract_text("img.png", b"....");
        assert!(r.is_err());
    }
}

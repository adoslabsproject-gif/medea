//! Tier D — Output ricchi: chart SVG, table HTML, invoice HTML, letter HTML, CSV.
//! Tutto self-contained, A4-ready, no script, no font esterni.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::db;

use super::helpers::{ar, i, s};

const SVG_W: f64 = 720.0;
const SVG_H: f64 = 360.0;
const MARGIN: f64 = 40.0;

/// Genera SVG inline per bar | line | pie | donut | area chart.
pub fn documents_compose_chart(args: &Value) -> Result<Value> {
    let kind = s(args, "type").unwrap_or_else(|| "bar".into());
    let data = ar(args, "data")
        .ok_or_else(|| anyhow!("manca 'data' (array di {{label, value}})"))?
        .iter()
        .map(|v| {
            let label = v.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let value = v.get("value").and_then(|x| x.as_f64()).unwrap_or(0.0);
            (label, value)
        })
        .collect::<Vec<_>>();
    if data.is_empty() {
        return Err(anyhow!("Dati vuoti"));
    }
    let title = s(args, "title").unwrap_or_default();
    let svg = match kind.as_str() {
        "bar" => svg_bar(&data, &title),
        "line" => svg_line(&data, &title, false),
        "area" => svg_line(&data, &title, true),
        "pie" => svg_pie(&data, &title, false),
        "donut" => svg_pie(&data, &title, true),
        other => return Err(anyhow!("type '{other}' non supportato (bar|line|area|pie|donut)")),
    };
    Ok(json!({ "kind": "read", "type": kind, "title": title, "svg": svg }))
}

fn svg_bar(data: &[(String, f64)], title: &str) -> String {
    let max = data.iter().map(|(_, v)| *v).fold(0.0_f64, f64::max).max(1.0);
    let bar_w = (SVG_W - MARGIN * 2.0) / data.len() as f64;
    let mut bars = String::new();
    for (i, (lab, v)) in data.iter().enumerate() {
        let h = (v / max) * (SVG_H - MARGIN * 2.0 - 24.0);
        let x = MARGIN + bar_w * i as f64 + bar_w * 0.1;
        let y = SVG_H - MARGIN - h;
        bars.push_str(&format!(
            "<rect x='{x:.1}' y='{y:.1}' width='{w:.1}' height='{h:.1}' fill='#5b8def' rx='3'/>\
             <text x='{xt:.1}' y='{yt:.1}' font-size='10' text-anchor='middle' fill='#333'>{lab}</text>\
             <text x='{xt:.1}' y='{yv:.1}' font-size='10' text-anchor='middle' fill='#555'>{v:.0}</text>",
            w = bar_w * 0.8, xt = x + bar_w * 0.4, yt = SVG_H - MARGIN + 14.0, yv = y - 4.0,
            lab = escape_xml(lab)
        ));
    }
    wrap_svg(&format!(
        "<text x='{cx}' y='24' font-size='14' text-anchor='middle' fill='#222' font-weight='600'>{t}</text>\
         <line x1='{x1}' y1='{y1:.1}' x2='{x2}' y2='{y1:.1}' stroke='#ddd'/>{bars}",
        cx = SVG_W / 2.0, t = escape_xml(title),
        x1 = MARGIN, x2 = SVG_W - MARGIN, y1 = SVG_H - MARGIN
    ))
}

fn svg_line(data: &[(String, f64)], title: &str, area: bool) -> String {
    let max = data.iter().map(|(_, v)| *v).fold(0.0_f64, f64::max).max(1.0);
    let step = (SVG_W - MARGIN * 2.0) / (data.len() as f64 - 1.0).max(1.0);
    let mut path = String::from("M ");
    let mut points = String::new();
    for (i, (lab, v)) in data.iter().enumerate() {
        let x = MARGIN + step * i as f64;
        let y = SVG_H - MARGIN - (v / max) * (SVG_H - MARGIN * 2.0 - 24.0);
        if i == 0 { path.push_str(&format!("{x:.1} {y:.1}")); }
        else      { path.push_str(&format!(" L {x:.1} {y:.1}")); }
        points.push_str(&format!(
            "<circle cx='{x:.1}' cy='{y:.1}' r='3' fill='#5b8def'/>\
             <text x='{x:.1}' y='{yt:.1}' font-size='9' text-anchor='middle' fill='#666'>{lab}</text>",
            yt = SVG_H - MARGIN + 14.0, lab = escape_xml(lab)
        ));
    }
    let area_path = if area {
        let last_x = MARGIN + step * (data.len() as f64 - 1.0);
        format!(
            "<path d='{p} L {x:.1} {y:.1} L {x0} {y:.1} Z' fill='#5b8def' opacity='0.18'/>",
            p = path, x = last_x, y = SVG_H - MARGIN, x0 = MARGIN
        )
    } else { String::new() };
    wrap_svg(&format!(
        "<text x='{cx}' y='24' font-size='14' text-anchor='middle' fill='#222' font-weight='600'>{t}</text>\
         {area}<path d='{path}' fill='none' stroke='#5b8def' stroke-width='2'/>{pts}",
        cx = SVG_W / 2.0, t = escape_xml(title), pts = points, area = area_path
    ))
}

fn svg_pie(data: &[(String, f64)], title: &str, donut: bool) -> String {
    let total: f64 = data.iter().map(|(_, v)| *v).sum::<f64>().max(0.000001);
    let cx = SVG_W / 2.0;
    let cy = SVG_H / 2.0 + 8.0;
    let r = 130.0_f64;
    let inner = if donut { 60.0 } else { 0.0 };
    let palette = ["#5b8def", "#7c5cd9", "#10b981", "#f59e0b", "#ef4444",
                   "#06b6d4", "#ec4899", "#84cc16", "#6366f1", "#f43f5e"];
    let mut slices = String::new();
    let mut legend = String::new();
    let mut start = -std::f64::consts::FRAC_PI_2;
    for (i, (lab, v)) in data.iter().enumerate() {
        let frac = v / total;
        let end = start + frac * std::f64::consts::TAU;
        let color = palette[i % palette.len()];
        let large = if frac > 0.5 { 1 } else { 0 };
        let (x1, y1) = (cx + r * start.cos(), cy + r * start.sin());
        let (x2, y2) = (cx + r * end.cos(),   cy + r * end.sin());
        if donut {
            let (ix1, iy1) = (cx + inner * end.cos(),   cy + inner * end.sin());
            let (ix2, iy2) = (cx + inner * start.cos(), cy + inner * start.sin());
            slices.push_str(&format!(
                "<path d='M {x1:.1} {y1:.1} A {r} {r} 0 {large} 1 {x2:.1} {y2:.1} \
                 L {ix1:.1} {iy1:.1} A {inner} {inner} 0 {large} 0 {ix2:.1} {iy2:.1} Z' \
                 fill='{color}' stroke='#fff' stroke-width='1'/>"
            ));
        } else {
            slices.push_str(&format!(
                "<path d='M {cx} {cy} L {x1:.1} {y1:.1} A {r} {r} 0 {large} 1 {x2:.1} {y2:.1} Z' \
                 fill='{color}' stroke='#fff' stroke-width='1'/>"
            ));
        }
        legend.push_str(&format!(
            "<rect x='{lx}' y='{ly}' width='10' height='10' fill='{color}'/>\
             <text x='{tx}' y='{ty}' font-size='11' fill='#333'>{lab} ({pct:.1}%)</text>",
            lx = 20, ly = 40 + i as i32 * 18, tx = 36, ty = 49 + i as i32 * 18,
            lab = escape_xml(lab), pct = frac * 100.0
        ));
        start = end;
    }
    wrap_svg(&format!(
        "<text x='{cx}' y='24' font-size='14' text-anchor='middle' fill='#222' font-weight='600'>{t}</text>\
         {slices}{legend}",
        cx = SVG_W / 2.0, t = escape_xml(title)
    ))
}

fn wrap_svg(inner: &str) -> String {
    format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {w} {h}' \
         style='max-width:100%;height:auto;font-family:system-ui,sans-serif;'>{inner}</svg>",
        w = SVG_W, h = SVG_H, inner = inner
    )
}

fn escape_xml(s: &str) -> String {
    s.chars().map(|c| match c {
        '<' => "&lt;".into(), '>' => "&gt;".into(), '&' => "&amp;".into(),
        '"' => "&quot;".into(), '\'' => "&apos;".into(), _ => c.to_string(),
    }).collect()
}

// ── Tabella HTML stylata standalone ───────────────────────────────────────

pub fn documents_compose_table(args: &Value) -> Result<Value> {
    let columns = ar(args, "columns")
        .ok_or_else(|| anyhow!("manca 'columns'"))?
        .iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>();
    let rows = ar(args, "rows")
        .ok_or_else(|| anyhow!("manca 'rows'"))?;
    let style = s(args, "style").unwrap_or_else(|| "default".into());
    let header_bg = if style == "accent" { "#5b8def" } else { "#f4f4f6" };
    let header_fg = if style == "accent" { "#fff" } else { "#222" };
    let mut html = String::from("<table style='width:100%;border-collapse:collapse;font-family:system-ui;font-size:13px'>");
    html.push_str("<thead><tr>");
    for c in &columns {
        html.push_str(&format!("<th style='background:{header_bg};color:{header_fg};padding:8px 10px;text-align:left;border-bottom:1px solid #ddd'>{}</th>", html_escape(c)));
    }
    html.push_str("</tr></thead><tbody>");
    for (idx, row) in rows.iter().enumerate() {
        let bg = if idx % 2 == 0 { "#fff" } else { "#fafafa" };
        html.push_str(&format!("<tr style='background:{bg}'>"));
        if let Some(arr) = row.as_array() {
            for cell in arr {
                let txt = match cell {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    Value::Bool(b) => b.to_string(),
                    Value::Null => "".to_string(),
                    other => other.to_string(),
                };
                html.push_str(&format!("<td style='padding:7px 10px;border-bottom:1px solid #eee'>{}</td>", html_escape(&txt)));
            }
        } else if let Some(obj) = row.as_object() {
            for c in &columns {
                let val = obj.get(c).cloned().unwrap_or(Value::Null);
                let txt = match val {
                    Value::String(s) => s,
                    Value::Number(n) => n.to_string(),
                    Value::Bool(b) => b.to_string(),
                    Value::Null => "".to_string(),
                    other => other.to_string(),
                };
                html.push_str(&format!("<td style='padding:7px 10px;border-bottom:1px solid #eee'>{}</td>", html_escape(&txt)));
            }
        }
        html.push_str("</tr>");
    }
    html.push_str("</tbody></table>");
    Ok(json!({ "kind": "read", "html": html, "rowCount": rows.len(), "colCount": columns.len() }))
}

fn html_escape(s: &str) -> String {
    s.chars().map(|c| match c {
        '<' => "&lt;".into(), '>' => "&gt;".into(), '&' => "&amp;".into(),
        '"' => "&quot;".into(), '\'' => "&#39;".into(), _ => c.to_string(),
    }).collect()
}

// ── Invoice A4 (pro-forma) ────────────────────────────────────────────────

pub fn documents_compose_invoice(args: &Value) -> Result<Value> {
    let customer_id = i(args, "customerId").ok_or_else(|| anyhow!("manca 'customerId'"))?;
    let doc_date = s(args, "docDate").unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
    let doc_number = s(args, "docNumber").unwrap_or_else(|| {
        format!("PF-{}", chrono::Local::now().format("%Y%m%d%H%M"))
    });
    let items = ar(args, "items").cloned().unwrap_or_default();
    let cust = db::with_db(|c| db::anag::get_organization(c, customer_id))?
        .ok_or_else(|| anyhow!("cliente id={customer_id} non trovato"))?;
    let articles = db::with_db(|c| db::anag::list_articles(c, 20_000, 0))?;

    let mut rows = String::new();
    let mut total: f64 = 0.0;
    for it in &items {
        let code = it.get("code").and_then(|v| v.as_str()).unwrap_or("");
        let qty = it.get("qty").and_then(|v| v.as_f64()).unwrap_or(1.0);
        let art = articles.iter().find(|a| a.code.eq_ignore_ascii_case(code));
        let (desc, price) = match art {
            Some(a) => (a.description.clone(), it.get("unitPrice").and_then(|v| v.as_f64()).or(a.sale_price).unwrap_or(0.0)),
            None => (
                it.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                it.get("unitPrice").and_then(|v| v.as_f64()).unwrap_or(0.0),
            ),
        };
        let row_total = qty * price;
        total += row_total;
        rows.push_str(&format!(
            "<tr><td>{c}</td><td>{d}</td><td class='num'>{q:.2}</td><td class='num'>€ {p:.2}</td><td class='num'>€ {t:.2}</td></tr>",
            c = html_escape(code), d = html_escape(&desc), q = qty, p = price, t = row_total
        ));
    }
    let vat = total * 0.22;
    let grand = total + vat;
    let html = invoice_html(
        &doc_number, &doc_date,
        cust.display_name.as_deref().unwrap_or(&cust.domain),
        cust.vat_number.as_deref().unwrap_or("—"),
        cust.street_address.as_deref().unwrap_or("—"),
        cust.city.as_deref().unwrap_or("—"),
        &rows, total, vat, grand,
    );
    Ok(json!({
        "kind": "proposal",
        "proposalType": "compose_html",
        "summary": format!("Pro-forma N. {doc_number} — {}", cust.display_name.as_deref().unwrap_or(&cust.domain)),
        "document": {
            "title": format!("Pro-forma N. {doc_number}"),
            "docKind": "report",
            "html": html,
            "customerId": customer_id,
            "suggestedFilename": format!("proforma-{}.html", doc_number),
        }
    }))
}

fn invoice_html(
    num: &str, date: &str, cust_name: &str, cust_vat: &str,
    cust_addr: &str, cust_city: &str, rows: &str,
    total: f64, vat: f64, grand: f64,
) -> String {
    format!(r#"<!doctype html><html><head><meta charset='utf-8'><style>
@page {{ size: A4; margin: 0; }}
html {{ background: #e2e8f0; }}
body {{ margin: 0; font-family: system-ui, sans-serif; color: #222; }}
.page {{ width: 210mm; min-height: 297mm; padding: 18mm; margin: 0 auto; background: #fff; box-shadow: 0 0 8px rgba(0,0,0,.1); box-sizing: border-box; }}
h1 {{ font-size: 22px; margin: 0 0 4px 0; }}
.meta {{ color: #666; font-size: 12px; margin-bottom: 24px; }}
.recipient {{ background: #f4f4f6; padding: 12px 16px; border-radius: 6px; margin: 16px 0; }}
.recipient .label {{ font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: .04em; }}
table {{ width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }}
th {{ background: #f4f4f6; text-align: left; padding: 8px 10px; border-bottom: 1px solid #ddd; }}
td {{ padding: 8px 10px; border-bottom: 1px solid #eee; }}
.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
.totals {{ margin-top: 24px; width: 100%; }}
.totals td {{ border: 0; padding: 4px 10px; }}
.totals .grand {{ font-weight: 700; font-size: 15px; }}
.foot {{ margin-top: 36px; font-size: 11px; color: #888; line-height: 1.55; }}
</style></head><body><div class='page'>
<h1>Pro-forma N. {num}</h1>
<div class='meta'>Data: {date}</div>
<div class='recipient'>
  <div class='label'>Destinatario</div>
  <div><strong>{cn}</strong></div>
  <div>{addr}</div>
  <div>{city}</div>
  <div>P.IVA: {vatn}</div>
</div>
<table><thead><tr><th>Codice</th><th>Descrizione</th><th class='num'>Q.tà</th><th class='num'>Prezzo</th><th class='num'>Totale</th></tr></thead>
<tbody>{rows}</tbody></table>
<table class='totals'><tr><td></td><td></td><td></td><td>Imponibile:</td><td class='num'>€ {tot:.2}</td></tr>
<tr><td></td><td></td><td></td><td>IVA 22%:</td><td class='num'>€ {vat:.2}</td></tr>
<tr><td></td><td></td><td></td><td class='grand'>Totale documento:</td><td class='num grand'>€ {grand:.2}</td></tr></table>
<div class='foot'>Documento generato da Medea — pro-forma non fiscale. Validità offerta: 30 giorni. Pagamento secondo condizioni concordate.</div>
</div></body></html>"#,
        num = html_escape(num), date = html_escape(date),
        cn = html_escape(cust_name), vatn = html_escape(cust_vat),
        addr = html_escape(cust_addr), city = html_escape(cust_city),
        rows = rows, tot = total, vat = vat, grand = grand,
    )
}

// ── Lettera A4 ─────────────────────────────────────────────────────────────

pub fn documents_compose_letter(args: &Value) -> Result<Value> {
    let recipient_id = i(args, "recipientId").ok_or_else(|| anyhow!("manca 'recipientId'"))?;
    let template = s(args, "template").unwrap_or_else(|| "generic".into());
    let fields = args.get("fields").cloned().unwrap_or(Value::Object(Default::default()));
    let r = db::with_db(|c| db::anag::get_organization(c, recipient_id))?
        .ok_or_else(|| anyhow!("destinatario id={recipient_id} non trovato"))?;
    let title = match template.as_str() {
        "sollecito" => "Sollecito di pagamento",
        "reclamo" => "Comunicazione di reclamo",
        "benvenuto" => "Benvenuto",
        "aumento_listino" => "Aggiornamento listino",
        "accompagnamento_ordine" => "Accompagnamento ordine",
        _ => "Comunicazione",
    };
    let body_html = letter_body(&template, &fields);
    let html = letter_html(
        title,
        r.display_name.as_deref().unwrap_or(&r.domain),
        r.street_address.as_deref().unwrap_or(""),
        r.city.as_deref().unwrap_or(""),
        &body_html,
    );
    Ok(json!({
        "kind": "proposal",
        "proposalType": "compose_html",
        "summary": format!("Lettera «{title}» per «{}»", r.display_name.as_deref().unwrap_or(&r.domain)),
        "document": {
            "title": format!("{title} — {}", r.display_name.as_deref().unwrap_or(&r.domain)),
            "docKind": "letter",
            "html": html,
            "customerId": recipient_id,
            "suggestedFilename": format!("lettera-{}-{}.html", template, recipient_id),
        }
    }))
}

fn letter_body(template: &str, fields: &Value) -> String {
    let get = |k: &str| -> String {
        fields.get(k).and_then(|v| v.as_str()).map(|s| s.to_string())
            .or_else(|| fields.get(k).and_then(|v| v.as_f64()).map(|n| format!("{n:.2}")))
            .or_else(|| fields.get(k).and_then(|v| v.as_i64()).map(|n| n.to_string()))
            .unwrap_or_default()
    };
    match template {
        "sollecito" => format!(
            "<p>Spettabile Cliente,</p><p>risulta da nostre scritture un importo di <strong>€ {imp}</strong> non ancora regolato.</p>\
             <p>La invitiamo cortesemente a verificare e procedere al pagamento quanto prima.</p>\
             <p>Restiamo a disposizione per qualsiasi chiarimento.</p>",
            imp = html_escape(&get("importo"))
        ),
        "reclamo" => format!(
            "<p>Spett.le Fornitore,</p><p>siamo a segnalare quanto segue: <em>{m}</em></p>\
             <p>Vi chiediamo di intervenire entro 10 giorni lavorativi.</p>",
            m = html_escape(&get("motivo"))
        ),
        "benvenuto" => "<p>Benvenuto tra i nostri clienti.</p><p>Siamo lieti di iniziare questa collaborazione e restiamo a Sua disposizione per qualsiasi necessità.</p>".to_string(),
        "aumento_listino" => format!(
            "<p>Con la presente Vi comunichiamo che, a partire dalla data odierna, i listini subiranno un incremento medio del <strong>{p}%</strong>.</p>",
            p = html_escape(&get("percentuale"))
        ),
        "accompagnamento_ordine" => format!(
            "<p>In allegato il documento <strong>{n}</strong>.</p>\
             <p>Restiamo a disposizione per ogni necessità.</p>",
            n = html_escape(&get("docNumber"))
        ),
        _ => "<p>Comunicazione operativa.</p>".to_string(),
    }
}

fn letter_html(title: &str, dest_name: &str, addr: &str, city: &str, body: &str) -> String {
    let today = chrono::Local::now().format("%d/%m/%Y").to_string();
    format!(r#"<!doctype html><html><head><meta charset='utf-8'><style>
@page {{ size: A4; margin: 0; }}
html {{ background: #e2e8f0; }}
body {{ margin: 0; font-family: 'Times New Roman', Georgia, serif; color: #222; }}
.page {{ width: 210mm; min-height: 297mm; padding: 25mm 22mm; margin: 0 auto; background: #fff; box-shadow: 0 0 8px rgba(0,0,0,.1); box-sizing: border-box; }}
.head {{ display: flex; justify-content: space-between; margin-bottom: 60px; font-size: 13px; }}
.dest {{ text-align: right; }}
h1 {{ font-size: 20px; font-weight: 600; margin: 0 0 24px 0; }}
.body p {{ font-size: 14px; line-height: 1.7; margin: 0 0 12px 0; }}
.sign {{ margin-top: 60px; text-align: right; font-size: 14px; }}
</style></head><body><div class='page'>
<div class='head'>
  <div></div>
  <div class='dest'><strong>{dest}</strong><br/>{addr}<br/>{city}</div>
</div>
<h1>{title}</h1>
<div class='body'>{body}</div>
<div class='sign'>
  <p>{today}</p>
  <p>Cordiali saluti</p>
</div>
</div></body></html>"#,
        title = html_escape(title), dest = html_escape(dest_name),
        addr = html_escape(addr), city = html_escape(city),
        body = body, today = today,
    )
}

// ── CSV self-contained ────────────────────────────────────────────────────

pub fn documents_compose_csv(args: &Value) -> Result<Value> {
    let columns = ar(args, "columns")
        .ok_or_else(|| anyhow!("manca 'columns'"))?
        .iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>();
    let rows = ar(args, "rows").cloned().unwrap_or_default();
    let filename = s(args, "filename").unwrap_or_else(|| "export.csv".into());

    let mut out = String::new();
    out.push_str(&columns.iter().map(|c| csv_escape(c)).collect::<Vec<_>>().join(","));
    out.push('\n');
    for row in &rows {
        let line: Vec<String> = if let Some(arr) = row.as_array() {
            arr.iter().map(|c| csv_escape(&value_to_string(c))).collect()
        } else if let Some(obj) = row.as_object() {
            columns.iter().map(|k| csv_escape(&value_to_string(obj.get(k).unwrap_or(&Value::Null)))).collect()
        } else {
            Vec::new()
        };
        out.push_str(&line.join(","));
        out.push('\n');
    }
    Ok(json!({
        "kind": "proposal",
        "proposalType": "save_text",
        "summary": format!("CSV: {} ({} righe)", filename, rows.len()),
        "filename": filename,
        "mimeType": "text/csv",
        "content": out,
        "rowCount": rows.len(),
    }))
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

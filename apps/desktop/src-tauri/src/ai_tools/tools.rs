//! Implementazioni dei tool — funzioni pure su DB locale.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::db;

use super::helpers::{account_id, i, s};

// ── address book (TUTTI gli indirizzi, non solo classificati) ─────────────

pub fn address_book_search(args: &Value) -> Result<Value> {
    let query = s(args, "query").ok_or_else(|| anyhow!("manca 'query'"))?;
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(json!({ "organizations": [], "contacts": [] }));
    }
    let orgs = db::with_db(|c| db::anag::list_organizations(c, 5000, 0))?;
    let org_hits: Vec<_> = orgs
        .iter()
        .filter(|o| {
            let n = [
                o.display_name.as_deref().unwrap_or("").to_lowercase(),
                o.domain.to_lowercase(),
                o.vat_number.as_deref().unwrap_or("").to_lowercase(),
                o.email_address.as_deref().unwrap_or("").to_lowercase(),
            ];
            n.iter().any(|x| x.contains(&q))
        })
        .take(20)
        .collect();

    let contacts = db::with_db(|c| db::anag::list_contacts(c, 5000, 0))?;
    let contact_hits: Vec<_> = contacts
        .iter()
        .filter(|c| {
            let n = [
                c.email_address.to_lowercase(),
                c.display_name.as_deref().unwrap_or("").to_lowercase(),
                c.organization_name.as_deref().unwrap_or("").to_lowercase(),
                c.organization_domain
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase(),
            ];
            n.iter().any(|x| x.contains(&q))
        })
        .take(30)
        .collect();

    Ok(json!({
        "query": query,
        "organizationsCount": org_hits.len(),
        "organizations": org_hits.iter().map(|o| json!({
            "id": o.id,
            "displayName": o.display_name,
            "domain": o.domain,
            "vatNumber": o.vat_number,
            "isClient": o.is_client,
            "isSupplier": o.is_supplier,
            "city": o.city,
            "email": o.email_address,
            "contactCount": o.contact_count,
        })).collect::<Vec<_>>(),
        "contactsCount": contact_hits.len(),
        "contacts": contact_hits.iter().map(|c| json!({
            "id": c.id,
            "email": c.email_address,
            "displayName": c.display_name,
            "orgName": c.organization_name,
            "orgDomain": c.organization_domain,
            "isClient": c.is_client,
            "isSupplier": c.is_supplier,
            "messageCount": c.message_count,
            "lastSeenAt": c.last_seen_at,
        })).collect::<Vec<_>>(),
    }))
}

// ── customers ──────────────────────────────────────────────────────────────

pub fn customers_search(args: &Value) -> Result<Value> {
    let query = s(args, "query").ok_or_else(|| anyhow!("manca 'query'"))?;
    let role = s(args, "role").unwrap_or_else(|| "any".to_string());
    let only_clients = role == "client";
    let only_suppliers = role == "supplier";

    let q = query.to_lowercase();
    let list = db::with_db(|c| db::anag::list_business_partners(c, only_clients, only_suppliers))?;
    let filtered: Vec<_> = list
        .iter()
        .filter(|o| {
            let needle = [
                o.display_name.as_deref().unwrap_or("").to_lowercase(),
                o.domain.to_lowercase(),
                o.vat_number.as_deref().unwrap_or("").to_lowercase(),
                o.email_address.as_deref().unwrap_or("").to_lowercase(),
            ];
            needle.iter().any(|n| n.contains(&q))
        })
        .take(20)
        .collect();

    Ok(json!({
        "count": filtered.len(),
        "results": filtered.iter().map(|o| json!({
            "id": o.id,
            "displayName": o.display_name,
            "domain": o.domain,
            "vatNumber": o.vat_number,
            "isClient": o.is_client,
            "isSupplier": o.is_supplier,
            "city": o.city,
            "countryIso2": o.country_iso2,
            "email": o.email_address,
            "contactCount": o.contact_count,
        })).collect::<Vec<_>>()
    }))
}

pub fn customers_get(args: &Value) -> Result<Value> {
    let id = i(args, "id").ok_or_else(|| anyhow!("manca 'id'"))?;
    let detail = db::with_db(|c| db::anag::get_organization(c, id))?
        .ok_or_else(|| anyhow!("organizzazione id={id} non trovata"))?;
    let discounts = db::with_db(|c| db::crud::list_customer_discounts(c, id))?;
    let overrides = db::with_db(|c| db::crud::list_customer_price_overrides(c, id))?;
    let docs = db::with_db(|c| db::crud::list_customer_documents(c, id, None))?;
    let docs_top: Vec<_> = docs.iter().take(10).collect();
    Ok(json!({
        "id": detail.id,
        "displayName": detail.display_name,
        "domain": detail.domain,
        "isClient": detail.is_client,
        "isSupplier": detail.is_supplier,
        "fiscal": {
            "vatNumber": detail.vat_number,
            "taxCode":   detail.tax_code,
            "sdiCode":   detail.sdi_code,
            "pec":       detail.pec,
        },
        "contact": {
            "email":   detail.email_address,
            "phone":   detail.phone,
            "website": detail.website,
        },
        "address": {
            "street": detail.street_address,
            "city":   detail.city,
            "postalCode": detail.postal_code,
            "province": detail.province,
            "countryIso2": detail.country_iso2,
        },
        "bank": {
            "iban": detail.iban,
            "name": detail.bank_name,
        },
        "operationalDefaults": {
            "preferredCourier": detail.preferred_courier,
            "paymentTerms":     detail.payment_terms,
            "shippingTerms":    detail.shipping_terms,
            "preferredLanguage": detail.preferred_language,
        },
        "notes": detail.notes,
        "discounts": discounts.iter().map(|d| json!({
            "category": d.category_name,
            "brand":    d.brand_name,
            "pct":      d.discount_pct,
        })).collect::<Vec<_>>(),
        "priceOverrides": overrides.iter().map(|o| json!({
            "code": o.article_code,
            "description": o.article_description,
            "unitPrice": o.unit_price,
            "currency":  o.currency,
        })).collect::<Vec<_>>(),
        "recentDocuments": docs_top.iter().map(|d| json!({
            "id": d.id,
            "type": d.doc_type,
            "direction": d.direction,
            "date": d.doc_date,
            "number": d.doc_number,
            "total": d.total_amount,
            "currency": d.currency,
            "attachment": d.attachment_filename,
        })).collect::<Vec<_>>(),
    }))
}

// ── articles ───────────────────────────────────────────────────────────────

pub fn articles_search(args: &Value) -> Result<Value> {
    let query = s(args, "query").ok_or_else(|| anyhow!("manca 'query'"))?;
    let q = query.to_lowercase();
    let list = db::with_db(|c| db::anag::list_articles(c, 1000, 0))?;
    let filtered: Vec<_> = list
        .iter()
        .filter(|a| {
            let needle = [
                a.code.to_lowercase(),
                a.description.to_lowercase(),
                a.brand_name.as_deref().unwrap_or("").to_lowercase(),
                a.category_name.as_deref().unwrap_or("").to_lowercase(),
            ];
            needle.iter().any(|n| n.contains(&q))
        })
        .take(30)
        .collect();
    Ok(json!({
        "count": filtered.len(),
        "results": filtered.iter().map(|a| json!({
            "id": a.id,
            "code": a.code,
            "description": a.description,
            "brand": a.brand_name,
            "category": a.category_name,
            "salePrice": a.sale_price,
            "purchasePrice": a.purchase_price,
            "currency": a.currency,
            "boxQuantity": a.box_quantity,
            "countryOfOrigin": a.country_of_origin,
            "hsCode": a.hs_code,
            "isActive": a.is_active,
        })).collect::<Vec<_>>()
    }))
}

pub fn articles_get(args: &Value) -> Result<Value> {
    let code = s(args, "code").ok_or_else(|| anyhow!("manca 'code'"))?;
    let list = db::with_db(|c| db::anag::list_articles(c, 5000, 0))?;
    let found = list
        .iter()
        .find(|a| a.code.eq_ignore_ascii_case(&code))
        .ok_or_else(|| anyhow!("articolo '{code}' non trovato"))?;
    Ok(json!({
        "id": found.id,
        "code": found.code,
        "description": found.description,
        "unit": found.unit,
        "brand": found.brand_name,
        "category": found.category_name,
        "salePrice": found.sale_price,
        "purchasePrice": found.purchase_price,
        "currency": found.currency,
        "vatPercent": found.vat_percent,
        "boxQuantity": found.box_quantity,
        "countryOfOrigin": found.country_of_origin,
        "hsCode": found.hs_code,
        "isActive": found.is_active,
    }))
}

// ── pricing ────────────────────────────────────────────────────────────────

pub fn pricing_resolve(args: &Value) -> Result<Value> {
    let customer_id = i(args, "customerId").ok_or_else(|| anyhow!("manca 'customerId'"))?;
    let code = s(args, "code").ok_or_else(|| anyhow!("manca 'code'"))?;
    let qty = args.get("quantity").and_then(|v| v.as_f64()).unwrap_or(1.0);

    let res = db::with_db(|c| db::pricing::resolve_for_customer(c, customer_id, &code))?
        .ok_or_else(|| anyhow!("articolo '{code}' non trovato"))?;

    let line_total = res.final_price.map(|p| p * qty);
    Ok(json!({
        "articleCode": res.article_code,
        "description": res.article_description,
        "listPrice":   res.list_price,
        "overridePrice": res.override_price,
        "discountPct": res.discount_pct_applied,
        "discountSource": res.discount_source,
        "finalUnitPrice": res.final_price,
        "currency": res.currency,
        "quantity": qty,
        "lineTotal": line_total,
    }))
}

// ── documents ──────────────────────────────────────────────────────────────

pub fn documents_list(args: &Value) -> Result<Value> {
    let org_id = i(args, "organizationId").ok_or_else(|| anyhow!("manca 'organizationId'"))?;
    let doc_type = s(args, "docType");
    let docs = db::with_db(|c| db::crud::list_customer_documents(c, org_id, doc_type.as_deref()))?;
    Ok(json!({
        "count": docs.len(),
        "results": docs.iter().map(|d| json!({
            "id": d.id,
            "type": d.doc_type,
            "direction": d.direction,
            "number": d.doc_number,
            "date": d.doc_date,
            "status": d.status,
            "total": d.total_amount,
            "currency": d.currency,
            "messageId": d.message_id,
            "attachment": d.attachment_filename,
            "notes": d.notes,
        })).collect::<Vec<_>>()
    }))
}

// ── messages ───────────────────────────────────────────────────────────────

pub fn messages_search_global(args: &Value) -> Result<Value> {
    let account_id = account_id(args)?;
    let query = s(args, "query").ok_or_else(|| anyhow!("manca 'query'"))?;
    let limit = i(args, "limit").unwrap_or(30).clamp(1, 100) as u32;
    let hits = db::with_db(|c| db::messages::search_fts(c, &account_id, &query, limit))?;
    Ok(json!({
        "query": query,
        "count": hits.len(),
        "results": hits.iter().map(|h| json!({
            "messageId": h.message_id,
            "subject": h.subject,
            "from": h.from_address,
            "date": h.internal_date,
            "snippet": h.snippet,
            "rank": h.rank,
        })).collect::<Vec<_>>()
    }))
}

pub fn messages_search_for_domain(args: &Value) -> Result<Value> {
    let account_id = account_id(args)?;
    let domain = s(args, "domain").ok_or_else(|| anyhow!("manca 'domain'"))?;
    let limit = i(args, "limit").unwrap_or(50).clamp(1, 200) as u32;
    let list = db::with_db(|c| db::messages::list_for_domain(c, &account_id, &domain, limit))?;
    Ok(json!({
        "count": list.len(),
        "domain": domain,
        "results": list.iter().map(|m| json!({
            "id": m.id,
            "date": m.internal_date,
            "from": m.from_address,
            "fromName": m.from_name,
            "subject": m.subject,
            "preview": m.preview,
            "folder": m.folder_path,
            "seen": m.is_seen,
            "hasAttachments": m.has_attachments,
        })).collect::<Vec<_>>()
    }))
}

// ── attachments ────────────────────────────────────────────────────────────

pub fn attachments_list(args: &Value) -> Result<Value> {
    let message_id = i(args, "messageId").ok_or_else(|| anyhow!("manca 'messageId'"))?;
    let list = db::with_db(|c| db::messages::list_attachments_with_threat(c, message_id))?;
    Ok(json!({
        "messageId": message_id,
        "count": list.len(),
        "results": list.iter().map(|a| json!({
            "index": a.index,
            "filename": a.filename,
            "contentType": a.content_type,
            "sizeBytes": a.size_bytes,
            "isInline": a.is_inline,
            "threatLevel": format!("{:?}", a.threat.level).to_lowercase(),
        })).collect::<Vec<_>>()
    }))
}

pub fn attachments_read_text(args: &Value) -> Result<Value> {
    let message_id = i(args, "messageId").ok_or_else(|| anyhow!("manca 'messageId'"))?;
    let part_index = i(args, "partIndex").ok_or_else(|| anyhow!("manca 'partIndex'"))? as usize;
    let bytes_triple =
        db::with_db(|c| db::messages::get_attachment_bytes(c, message_id, part_index))?;
    let Some((filename, ctype, bytes)) = bytes_triple else {
        return Err(anyhow!(
            "Allegato non trovato (msg={message_id}, idx={part_index})"
        ));
    };
    let text = crate::ai_tools::attachments::extract_text(&filename, &bytes)?;
    let truncated = text.chars().count() > 20_000;
    let final_text: String = if truncated {
        text.chars().take(20_000).collect::<String>() + "\n[…testo troncato a 20k caratteri…]"
    } else {
        text
    };
    Ok(json!({
        "filename": filename,
        "contentType": ctype,
        "byteSize": bytes.len(),
        "truncated": truncated,
        "text": final_text,
    }))
}

// ── proposals (azioni con conferma utente) ─────────────────────────────────

pub fn mail_compose_draft(args: &Value) -> Result<Value> {
    let to: Vec<String> = args
        .get("to")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if to.is_empty() {
        return Err(anyhow!("'to' è obbligatorio (lista email destinatari)"));
    }
    let subject = s(args, "subject").unwrap_or_default();
    let body_text = s(args, "bodyText").unwrap_or_default();
    let body_html = s(args, "bodyHtml");
    let cc: Vec<String> = args
        .get("cc")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let in_reply_to = s(args, "inReplyTo");

    Ok(json!({
        "kind": "proposal",
        "proposalType": "compose_draft",
        "summary": format!(
            "Bozza email per {} destinatar{} — oggetto: «{}»",
            to.len(),
            if to.len() == 1 { "io" } else { "i" },
            if subject.is_empty() { "(senza oggetto)" } else { subject.as_str() }
        ),
        "draft": {
            "to": to,
            "cc": cc,
            "subject": subject,
            "bodyText": body_text,
            "bodyHtml": body_html,
            "inReplyTo": in_reply_to,
        }
    }))
}

pub fn documents_compose_html(args: &Value) -> Result<Value> {
    let title = s(args, "title").ok_or_else(|| anyhow!("manca 'title'"))?;
    let html = s(args, "html").ok_or_else(|| anyhow!("manca 'html'"))?;
    // Cap hard: oltre questa soglia rifiutiamo la proposal per evitare crash
    // del WebView quando si rendea l'iframe. Il modello deve sintetizzare.
    const MAX_HTML_BYTES: usize = 200_000;
    if html.len() > MAX_HTML_BYTES {
        return Err(anyhow!(
            "Documento HTML troppo grande ({} bytes, max {}). Sintetizza il contenuto e ritenta.",
            html.len(),
            MAX_HTML_BYTES
        ));
    }
    let kind = s(args, "docKind").unwrap_or_else(|| "other".into());
    let customer_id = i(args, "customerId");
    let suggested_filename = s(args, "suggestedFilename").unwrap_or_else(|| {
        let safe = title
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let safe = safe.trim_matches('-').to_string();
        format!(
            "{}-{}.html",
            kind,
            if safe.is_empty() {
                "documento".to_string()
            } else {
                safe.chars().take(60).collect::<String>()
            }
        )
    });

    // Guard rail: l'AI non può iniettare <script>. Strippiamo per safety.
    let safe_html = strip_scripts(&html);

    Ok(json!({
        "kind": "proposal",
        "proposalType": "compose_html",
        "summary": format!("Documento {} pronto: «{}»", kind, title),
        "document": {
            "title": title,
            "docKind": kind,
            "html": safe_html,
            "customerId": customer_id,
            "suggestedFilename": suggested_filename,
        }
    }))
}

/// Rimuove `<script>...</script>` (case-insensitive) e gli attributi `on*`.
/// Char-safe per stringhe UTF-8 (sicuro su accenti italiani `à`, `è`, ecc.).
fn strip_scripts(s: &str) -> String {
    let lower = s.to_lowercase();
    // Strip blocchi <script>…</script> via find su byte index ma rispettando
    // i char boundary di `s` (lower e s hanno stessa byte-length per ASCII;
    // per i tag HTML va bene perché `<script>` e `</script>` sono ASCII).
    let mut out = String::with_capacity(s.len());
    let mut byte_cursor: usize = 0;
    while byte_cursor < s.len() {
        // cerca prossima occorrenza di "<script" dal cursore
        let remain = &lower[byte_cursor..];
        match remain.find("<script") {
            Some(rel_start) => {
                let abs_start = byte_cursor + rel_start;
                // copia il pezzo prima dello script
                out.push_str(&s[byte_cursor..abs_start]);
                // cerca chiusura
                let after_open = &lower[abs_start..];
                match after_open.find("</script>") {
                    Some(rel_end) => {
                        byte_cursor = abs_start + rel_end + "</script>".len();
                    }
                    None => {
                        // script aperto ma mai chiuso → scartiamo tutto il resto
                        return out;
                    }
                }
            }
            None => {
                out.push_str(&s[byte_cursor..]);
                break;
            }
        }
    }
    let mut result = out;
    for evt in [
        "onclick",
        "onload",
        "onerror",
        "onmouseover",
        "onfocus",
        "onsubmit",
        "onchange",
        "oninput",
        "onkeydown",
        "onkeyup",
        "onkeypress",
        "onmousedown",
        "onmouseup",
        "onmouseenter",
        "onmouseleave",
        "onpaste",
        "oncut",
        "oncopy",
        "onbeforeunload",
        "onunload",
        "onresize",
        "onscroll",
        "onwheel",
        "ontoggle",
    ] {
        result = strip_attr_ci(&result, evt);
    }
    result
}

/// Rimuove `attr="..."` / `attr='...'` (case-insensitive). Char-safe.
fn strip_attr_ci(input: &str, attr: &str) -> String {
    let lower = input.to_lowercase();
    let attr_low = attr.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut cursor: usize = 0;
    while cursor < input.len() {
        let remain = &lower[cursor..];
        match remain.find(&attr_low) {
            Some(rel_pos) => {
                let abs_attr = cursor + rel_pos;
                // copia il pezzo prima dell'attributo
                out.push_str(s_slice_safe(input, cursor, abs_attr));
                // dopo l'attributo: skip whitespace, deve esserci `=` e una quote
                let after_attr = abs_attr + attr_low.len();
                if after_attr >= input.len() {
                    out.push_str(&input[abs_attr..]);
                    break;
                }
                let post = &input[after_attr..];
                let trimmed = post.trim_start();
                let ws_skip = post.len() - trimmed.len();
                if !trimmed.starts_with('=') {
                    // non era un attr (era prefisso di un'altra parola): copia un char e avanza
                    let ch = input[abs_attr..].chars().next().unwrap_or('<');
                    out.push(ch);
                    cursor = abs_attr + ch.len_utf8();
                    continue;
                }
                // dopo `=` cerca la quote
                let post_eq = &trimmed[1..];
                let post_eq_trim = post_eq.trim_start();
                let pre_q_skip = post_eq.len() - post_eq_trim.len();
                let first = post_eq_trim.chars().next();
                match first {
                    Some('"') | Some('\'') => {
                        let quote = first.unwrap();
                        let inside = &post_eq_trim[1..];
                        match inside.find(quote) {
                            Some(end_rel) => {
                                let total_skip = ws_skip + 1 /* '=' */ + pre_q_skip + 1 /* opening quote */ + end_rel + 1 /* closing quote */;
                                cursor = after_attr + total_skip;
                                continue;
                            }
                            None => {
                                // quote mai chiusa → scarta resto
                                return out;
                            }
                        }
                    }
                    _ => {
                        // attr senza quote o senza valore: copia un char e avanza
                        let ch = input[abs_attr..].chars().next().unwrap_or('<');
                        out.push(ch);
                        cursor = abs_attr + ch.len_utf8();
                        continue;
                    }
                }
            }
            None => {
                out.push_str(&input[cursor..]);
                break;
            }
        }
    }
    out
}

/// Slice UTF-8 safe — se il range cade dentro un char multibyte, ritorna fallback.
fn s_slice_safe(s: &str, start: usize, end: usize) -> &str {
    if start > s.len() || end > s.len() || start > end {
        return "";
    }
    if !s.is_char_boundary(start) || !s.is_char_boundary(end) {
        return "";
    }
    &s[start..end]
}

// ── DB lettura avanzata (Tier 1) ──────────────────────────────────────────

/// Confronta il prezzo di un articolo in tutti i listini presenti in DB.
/// Ritorna: array di { listId, listName, isDefault, price, discountPct }
/// ordinato per prezzo crescente.
pub fn pricing_compare_lists(args: &Value) -> Result<Value> {
    let code = s(args, "code").ok_or_else(|| anyhow!("manca 'code'"))?;
    let rows = db::with_db(|c| {
        let mut stmt = c.prepare(
            "SELECT pl.id, pl.name, pl.is_default, pli.price, pli.discount_percent
               FROM price_list_items pli
               JOIN articles a ON a.id = pli.article_id
               JOIN price_lists pl ON pl.id = pli.price_list_id
              WHERE a.code = ?1
              ORDER BY pli.price ASC",
        )?;
        let r: Vec<(i64, String, bool, f64, f64)> = stmt
            .query_map(rusqlite::params![code], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok::<_, anyhow::Error>(r)
    })?;
    if rows.is_empty() {
        return Ok(
            json!({ "code": code, "count": 0, "results": [], "note": "articolo non in nessun listino" }),
        );
    }
    Ok(json!({
        "code": code,
        "count": rows.len(),
        "results": rows.iter().map(|(id, name, is_default, price, disc)| json!({
            "listId": id,
            "listName": name,
            "isDefault": is_default,
            "price": price,
            "discountPct": disc,
        })).collect::<Vec<_>>()
    }))
}

/// Prezzo di un articolo in un listino specifico (per nome). Se 'listino' è
/// omesso usa il listino marcato `is_default`.
pub fn articles_get_pricelist(args: &Value) -> Result<Value> {
    let code = s(args, "code").ok_or_else(|| anyhow!("manca 'code'"))?;
    let listino = s(args, "listino");
    let row = db::with_db(|c| {
        use rusqlite::OptionalExtension;
        let (sql, param): (&str, Option<&str>) = match listino.as_deref() {
            Some(name) => (
                "SELECT pl.id, pl.name, pli.price, pli.discount_percent
                   FROM price_list_items pli
                   JOIN articles a ON a.id = pli.article_id
                   JOIN price_lists pl ON pl.id = pli.price_list_id
                  WHERE a.code = ?1 AND pl.name = ?2 COLLATE NOCASE",
                Some(name),
            ),
            None => (
                "SELECT pl.id, pl.name, pli.price, pli.discount_percent
                   FROM price_list_items pli
                   JOIN articles a ON a.id = pli.article_id
                   JOIN price_lists pl ON pl.id = pli.price_list_id
                  WHERE a.code = ?1 AND pl.is_default = 1",
                None,
            ),
        };
        let query = |r: &rusqlite::Row<'_>| {
            Ok::<(i64, String, f64, f64), rusqlite::Error>((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
            ))
        };
        match param {
            Some(p) => c.query_row(sql, rusqlite::params![code, p], query),
            None => c.query_row(sql, rusqlite::params![code], query),
        }
        .optional()
        .map_err(anyhow::Error::from)
    })?;
    let requested = listino.clone().unwrap_or_else(|| "(default)".to_string());
    match row {
        Some((id, name, price, disc)) => Ok(json!({
            "code": code, "listId": id, "listName": name,
            "price": price, "discountPct": disc,
        })),
        None => Ok(json!({
            "code": code, "found": false,
            "note": format!("Articolo '{code}' non presente nel listino '{requested}'"),
        })),
    }
}

/// Lista articoli di un marchio (matching name su article_brands).
pub fn articles_by_brand(args: &Value) -> Result<Value> {
    let brand = s(args, "marchio").ok_or_else(|| anyhow!("manca 'marchio'"))?;
    let limit = i(args, "limit").unwrap_or(50).clamp(1, 500) as u32;
    let q = brand.to_lowercase();
    let list = db::with_db(|c| db::anag::list_articles(c, 5000, 0))?;
    // Filtro lato Rust per evitare query specifiche; sui 5447 articoli è ok.
    let filtered: Vec<_> = list
        .iter()
        .filter(|a| {
            a.brand_name
                .as_deref()
                .map(|n| n.to_lowercase().contains(&q))
                .unwrap_or(false)
        })
        .take(limit as usize)
        .collect();
    Ok(json!({
        "marchio": brand, "count": filtered.len(),
        "results": filtered.iter().map(|a| json!({
            "code": a.code, "description": a.description,
            "brand": a.brand_name, "category": a.category_name,
            "salePrice": a.sale_price, "currency": a.currency,
        })).collect::<Vec<_>>()
    }))
}

/// Lista articoli di una categoria.
pub fn articles_by_category(args: &Value) -> Result<Value> {
    let cat = s(args, "categoria").ok_or_else(|| anyhow!("manca 'categoria'"))?;
    let limit = i(args, "limit").unwrap_or(50).clamp(1, 500) as u32;
    let q = cat.to_lowercase();
    let list = db::with_db(|c| db::anag::list_articles(c, 5000, 0))?;
    let filtered: Vec<_> = list
        .iter()
        .filter(|a| {
            a.category_name
                .as_deref()
                .map(|n| n.to_lowercase().contains(&q))
                .unwrap_or(false)
        })
        .take(limit as usize)
        .collect();
    Ok(json!({
        "categoria": cat, "count": filtered.len(),
        "results": filtered.iter().map(|a| json!({
            "code": a.code, "description": a.description,
            "brand": a.brand_name, "category": a.category_name,
            "salePrice": a.sale_price, "currency": a.currency,
        })).collect::<Vec<_>>()
    }))
}

/// Storico utilizzo di un articolo: chi l'ha comprato, quante volte, ultima data.
pub fn articles_usage_history(args: &Value) -> Result<Value> {
    let code = s(args, "code").ok_or_else(|| anyhow!("manca 'code'"))?;
    let customer_id = i(args, "customerId"); // opzionale
    let rows = db::with_db(|c| {
        let sql = if customer_id.is_some() {
            "SELECT cd.organization_id, o.display_name,
                    cdi.quantity, cdi.unit_price, cdi.discount_pct, cdi.total,
                    cd.doc_type, cd.doc_date, cd.doc_number
               FROM customer_document_items cdi
               JOIN articles a ON a.id = cdi.article_id
               JOIN customer_documents cd ON cd.id = cdi.document_id
               JOIN organizations o ON o.id = cd.organization_id
              WHERE a.code = ?1 AND cd.organization_id = ?2
              ORDER BY cd.doc_date DESC LIMIT 50"
        } else {
            "SELECT cd.organization_id, o.display_name,
                    cdi.quantity, cdi.unit_price, cdi.discount_pct, cdi.total,
                    cd.doc_type, cd.doc_date, cd.doc_number
               FROM customer_document_items cdi
               JOIN articles a ON a.id = cdi.article_id
               JOIN customer_documents cd ON cd.id = cdi.document_id
               JOIN organizations o ON o.id = cd.organization_id
              WHERE a.code = ?1
              ORDER BY cd.doc_date DESC LIMIT 50"
        };
        let mut stmt = c.prepare(sql)?;
        let mapper = |r: &rusqlite::Row<'_>| -> rusqlite::Result<Value> {
            Ok(json!({
                "customerId": r.get::<_, i64>(0)?,
                "customerName": r.get::<_, Option<String>>(1)?,
                "quantity": r.get::<_, f64>(2)?,
                "unitPrice": r.get::<_, f64>(3)?,
                "discountPct": r.get::<_, Option<f64>>(4)?,
                "total": r.get::<_, Option<f64>>(5)?,
                "docType": r.get::<_, String>(6)?,
                "docDate": r.get::<_, String>(7)?,
                "docNumber": r.get::<_, Option<String>>(8)?,
            }))
        };
        let results: Vec<Value> = if let Some(cid) = customer_id {
            stmt.query_map(rusqlite::params![code, cid], mapper)?
                .collect::<rusqlite::Result<_>>()?
        } else {
            stmt.query_map(rusqlite::params![code], mapper)?
                .collect::<rusqlite::Result<_>>()?
        };
        Ok::<_, anyhow::Error>(results)
    })?;
    Ok(json!({ "code": code, "count": rows.len(), "results": rows }))
}

/// Profilo completo cliente: scheda + statistiche aggregate.
pub fn customers_profile(args: &Value) -> Result<Value> {
    let id = i(args, "id").ok_or_else(|| anyhow!("manca 'id'"))?;
    let detail = db::with_db(|c| db::anag::get_organization(c, id))?
        .ok_or_else(|| anyhow!("organizzazione id={id} non trovata"))?;
    let docs = db::with_db(|c| db::crud::list_customer_documents(c, id, None))?;

    // Statistiche
    let total_docs = docs.len();
    let total_amount: f64 = docs.iter().filter_map(|d| d.total_amount).sum();
    let last_doc_date = docs.iter().map(|d| &d.doc_date).max().cloned();
    let by_type: std::collections::HashMap<String, usize> = {
        let mut m = std::collections::HashMap::new();
        for d in &docs {
            *m.entry(d.doc_type.clone()).or_insert(0) += 1;
        }
        m
    };

    Ok(json!({
        "id": detail.id,
        "displayName": detail.display_name,
        "domain": detail.domain,
        "vatNumber": detail.vat_number,
        "taxCode": detail.tax_code,
        "isClient": detail.is_client, "isSupplier": detail.is_supplier,
        "city": detail.city, "country": detail.country_iso2,
        "stats": {
            "totalDocuments": total_docs,
            "totalAmount": total_amount,
            "currency": "EUR",
            "lastDocDate": last_doc_date,
            "byType": by_type,
        }
    }))
}

/// Default operativi cliente (corriere, pagamento, porto, lingua).
pub fn customers_preferred(args: &Value) -> Result<Value> {
    let id = i(args, "id").ok_or_else(|| anyhow!("manca 'id'"))?;
    let detail = db::with_db(|c| db::anag::get_organization(c, id))?
        .ok_or_else(|| anyhow!("id={id} non trovato"))?;
    Ok(json!({
        "id": id,
        "courier": detail.preferred_courier,
        "paymentTerms": detail.payment_terms,
        "shippingTerms": detail.shipping_terms,
        "language": detail.preferred_language,
    }))
}

// ── utility ────────────────────────────────────────────────────────────────

pub fn now(_args: &Value) -> Result<Value> {
    use chrono::Local;
    let now = Local::now();
    Ok(json!({
        "iso": now.to_rfc3339(),
        "date": now.format("%Y-%m-%d").to_string(),
        "time": now.format("%H:%M:%S").to_string(),
        "timezone": now.format("%Z").to_string(),
    }))
}

//! Tool di SCRITTURA — eseguono davvero la modifica sul DB locale.
//!
//! Sono marcati `sensitive` nel registry: il loop AI chiede conferma
//! all'utente PRIMA di eseguirli (consent gate, come nell'app Liara).
//! Una volta eseguiti ritornano l'esito reale, mai una promessa.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::db;
use crate::db::crud::{
    ArticleInput, CustomerDiscountInput, CustomerDocumentInput, CustomerPriceOverrideInput,
    OrganizationUpdate,
};

use super::helpers::{ar, f, i, s};

// ── helpers di patch ───────────────────────────────────────────────────────

fn ps(patch: &Value, key: &str, current: Option<String>) -> Option<String> {
    match patch.get(key) {
        Some(Value::Null) => None,
        Some(Value::String(v)) => Some(v.clone()),
        _ => current,
    }
}

fn pf(patch: &Value, key: &str, current: Option<f64>) -> Option<f64> {
    match patch.get(key) {
        Some(Value::Null) => None,
        Some(v) if v.is_number() => v.as_f64(),
        _ => current,
    }
}

fn pi(patch: &Value, key: &str, current: Option<i64>) -> Option<i64> {
    match patch.get(key) {
        Some(Value::Null) => None,
        Some(v) if v.is_i64() => v.as_i64(),
        _ => current,
    }
}

fn pb(patch: &Value, key: &str, current: bool) -> bool {
    patch.get(key).and_then(|v| v.as_bool()).unwrap_or(current)
}

// ── clienti / fornitori ────────────────────────────────────────────────────

/// Aggiorna i campi anagrafici di un cliente/fornitore. Il `patch` è parziale:
/// i campi non citati restano invariati (merge sulla riga corrente, perché il
/// repository sottostante fa un UPDATE full-row).
pub fn customer_update(args: &Value) -> Result<Value> {
    let id = i(args, "id").ok_or_else(|| anyhow!("manca 'id'"))?;
    let patch = args
        .get("patch")
        .ok_or_else(|| anyhow!("manca 'patch' (object con i campi da aggiornare)"))?;
    if !patch.is_object() {
        return Err(anyhow!("'patch' deve essere un object"));
    }
    let cur = db::with_db(|c| db::anag::get_organization(c, id))?
        .ok_or_else(|| anyhow!("organizzazione id={id} non trovata"))?;

    let update = OrganizationUpdate {
        id,
        display_name: ps(patch, "displayName", cur.display_name.clone()),
        vat_number: ps(patch, "vatNumber", cur.vat_number),
        address: ps(patch, "address", cur.address),
        phone: ps(patch, "phone", cur.phone),
        website: ps(patch, "website", cur.website),
        notes: ps(patch, "notes", cur.notes),
        is_client: pb(patch, "isClient", cur.is_client),
        is_supplier: pb(patch, "isSupplier", cur.is_supplier),
        tax_code: ps(patch, "taxCode", cur.tax_code),
        sdi_code: ps(patch, "sdiCode", cur.sdi_code),
        pec: ps(patch, "pec", cur.pec),
        iban: ps(patch, "iban", cur.iban),
        bank_name: ps(patch, "bankName", cur.bank_name),
        street_address: ps(patch, "streetAddress", cur.street_address),
        city: ps(patch, "city", cur.city),
        postal_code: ps(patch, "postalCode", cur.postal_code),
        province: ps(patch, "province", cur.province),
        country_iso2: ps(patch, "countryIso2", cur.country_iso2),
        preferred_courier: ps(patch, "preferredCourier", cur.preferred_courier),
        payment_terms: ps(patch, "paymentTerms", cur.payment_terms),
        shipping_terms: ps(patch, "shippingTerms", cur.shipping_terms),
        preferred_language: ps(patch, "preferredLanguage", cur.preferred_language),
        email_address: ps(patch, "emailAddress", cur.email_address),
    };
    db::with_db(|c| db::crud::organization_update(c, &update))?;

    let name = update
        .display_name
        .clone()
        .unwrap_or_else(|| cur.domain.clone());
    let fields = patch
        .as_object()
        .map(|o| o.keys().cloned().collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    Ok(json!({
        "id": id,
        "text": format!("Anagrafica «{name}» aggiornata (campi: {fields})."),
    }))
}

/// Classifica un'organizzazione come cliente / fornitore / entrambi / nessuno.
pub fn customer_classify(args: &Value) -> Result<Value> {
    let id = i(args, "id").ok_or_else(|| anyhow!("manca 'id'"))?;
    let role = s(args, "role").unwrap_or_else(|| "none".to_string());
    let (is_client, is_supplier) = match role.as_str() {
        "client" => (true, false),
        "supplier" => (false, true),
        "both" => (true, true),
        "none" => (false, false),
        _ => {
            return Err(anyhow!(
                "'role' deve essere 'client'|'supplier'|'both'|'none'"
            ))
        }
    };
    let cur = db::with_db(|c| db::anag::get_organization(c, id))?
        .ok_or_else(|| anyhow!("organizzazione id={id} non trovata"))?;
    db::with_db(|c| db::crud::organization_set_roles(c, id, is_client, is_supplier))?;
    let name = cur.display_name.unwrap_or(cur.domain);
    Ok(json!({
        "id": id,
        "isClient": is_client,
        "isSupplier": is_supplier,
        "text": format!("«{name}» classificata come {role}."),
    }))
}

// ── pricing / sconti ───────────────────────────────────────────────────────

/// Imposta un prezzo dedicato cliente × articolo (vince su ogni sconto).
pub fn pricing_set_override(args: &Value) -> Result<Value> {
    let customer_id = i(args, "customerId").ok_or_else(|| anyhow!("manca 'customerId'"))?;
    let code = s(args, "articleCode").ok_or_else(|| anyhow!("manca 'articleCode'"))?;
    let unit_price = f(args, "unitPrice").ok_or_else(|| anyhow!("manca 'unitPrice'"))?;
    if unit_price < 0.0 {
        return Err(anyhow!("'unitPrice' deve essere >= 0"));
    }
    let cust = db::with_db(|c| db::anag::get_organization(c, customer_id))?
        .ok_or_else(|| anyhow!("cliente id={customer_id} non trovato"))?;
    let articles = db::with_db(|c| db::anag::list_articles(c, 20_000, 0))?;
    let art = articles
        .iter()
        .find(|a| a.code.eq_ignore_ascii_case(&code))
        .ok_or_else(|| anyhow!("articolo '{code}' non trovato"))?;
    let currency = art.currency.clone();
    let input = CustomerPriceOverrideInput {
        id: None,
        customer_id,
        article_id: art.id,
        unit_price,
        currency: currency.clone(),
        notes: s(args, "notes"),
        valid_from: s(args, "validFrom"),
        valid_to: s(args, "validTo"),
    };
    let id = db::with_db(|c| db::crud::customer_price_override_upsert(c, &input))?;
    let name = cust.display_name.unwrap_or(cust.domain);
    Ok(json!({
        "id": id,
        "text": format!(
            "Prezzo dedicato impostato: {} → {:.2} {} per «{name}».",
            art.code, unit_price, currency.as_deref().unwrap_or("EUR")
        ),
    }))
}

/// Imposta lo sconto di un cliente per categoria × marchio.
pub fn discount_set(args: &Value) -> Result<Value> {
    let customer_id = i(args, "customerId").ok_or_else(|| anyhow!("manca 'customerId'"))?;
    let pct = f(args, "discountPct").ok_or_else(|| anyhow!("manca 'discountPct'"))?;
    if !(-100.0..=100.0).contains(&pct) {
        return Err(anyhow!("'discountPct' fuori range (-100..100)"));
    }
    let cust = db::with_db(|c| db::anag::get_organization(c, customer_id))?
        .ok_or_else(|| anyhow!("cliente id={customer_id} non trovato"))?;
    let input = CustomerDiscountInput {
        id: None,
        customer_id,
        category_id: i(args, "categoryId"),
        brand_id: i(args, "brandId"),
        discount_pct: pct,
        notes: s(args, "notes"),
    };
    let id = db::with_db(|c| db::crud::customer_discount_upsert(c, &input))?;
    let name = cust.display_name.unwrap_or(cust.domain);
    Ok(json!({
        "id": id,
        "text": format!("Sconto {pct:.1}% impostato per «{name}»."),
    }))
}

// ── articoli ───────────────────────────────────────────────────────────────

fn article_input_from(args: &Value, code: String, description: String) -> ArticleInput {
    ArticleInput {
        id: None,
        code,
        description,
        unit: s(args, "unit"),
        vat_percent: f(args, "vatPercent"),
        notes: s(args, "notes"),
        is_active: args
            .get("isActive")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        brand_id: i(args, "brandId"),
        category_id: i(args, "categoryId"),
        purchase_price: f(args, "purchasePrice"),
        sale_price: f(args, "salePrice"),
        currency: s(args, "currency"),
        box_quantity: i(args, "boxQuantity"),
        country_of_origin: s(args, "countryOfOrigin"),
        hs_code: s(args, "hsCode"),
    }
}

/// Crea un nuovo articolo a catalogo.
pub fn article_create(args: &Value) -> Result<Value> {
    let code = s(args, "code").ok_or_else(|| anyhow!("manca 'code'"))?;
    let description = s(args, "description").ok_or_else(|| anyhow!("manca 'description'"))?;
    if code.trim().is_empty() || description.trim().is_empty() {
        return Err(anyhow!("'code' e 'description' non possono essere vuoti"));
    }
    let existing = db::with_db(|c| db::anag::list_articles(c, 20_000, 0))?;
    if existing.iter().any(|a| a.code.eq_ignore_ascii_case(&code)) {
        return Err(anyhow!(
            "Codice articolo '{code}' già esistente: usa article_update"
        ));
    }
    let input = article_input_from(args, code.clone(), description.clone());
    let id = db::with_db(|c| db::crud::article_upsert(c, &input))?;
    Ok(json!({
        "id": id,
        "code": code,
        "text": format!("Articolo «{code}» creato: {description}"),
    }))
}

/// Aggiorna un articolo esistente (patch parziale sui campi citati).
pub fn article_update(args: &Value) -> Result<Value> {
    let code = s(args, "code").ok_or_else(|| anyhow!("manca 'code'"))?;
    let patch = args.get("patch").ok_or_else(|| anyhow!("manca 'patch'"))?;
    if !patch.is_object() {
        return Err(anyhow!("'patch' deve essere un object"));
    }
    let existing = db::with_db(|c| db::anag::list_articles(c, 20_000, 0))?;
    let art = existing
        .iter()
        .find(|a| a.code.eq_ignore_ascii_case(&code))
        .ok_or_else(|| anyhow!("articolo '{code}' non trovato"))?;

    let input = ArticleInput {
        id: Some(art.id),
        code: art.code.clone(),
        description: ps(patch, "description", Some(art.description.clone()))
            .unwrap_or_else(|| art.description.clone()),
        unit: ps(patch, "unit", art.unit.clone()),
        vat_percent: pf(patch, "vatPercent", art.vat_percent),
        notes: ps(patch, "notes", art.notes.clone()),
        is_active: pb(patch, "isActive", art.is_active),
        brand_id: pi(patch, "brandId", art.brand_id),
        category_id: pi(patch, "categoryId", art.category_id),
        purchase_price: pf(patch, "purchasePrice", art.purchase_price),
        sale_price: pf(patch, "salePrice", art.sale_price),
        currency: ps(patch, "currency", art.currency.clone()),
        box_quantity: pi(patch, "boxQuantity", art.box_quantity),
        country_of_origin: ps(patch, "countryOfOrigin", art.country_of_origin.clone()),
        hs_code: ps(patch, "hsCode", art.hs_code.clone()),
    };
    db::with_db(|c| db::crud::article_upsert(c, &input))?;
    let fields = patch
        .as_object()
        .map(|o| o.keys().cloned().collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    Ok(json!({
        "id": art.id,
        "code": art.code,
        "text": format!("Articolo «{}» aggiornato (campi: {fields}).", art.code),
    }))
}

/// Applica lo stesso patch a N articoli.
pub fn article_bulk_update(args: &Value) -> Result<Value> {
    let codes = ar(args, "codes")
        .ok_or_else(|| anyhow!("manca 'codes' (array di stringhe)"))?
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect::<Vec<_>>();
    if codes.is_empty() {
        return Err(anyhow!("La lista 'codes' è vuota"));
    }
    if codes.len() > 1000 {
        return Err(anyhow!("Troppi codici in un singolo bulk (max 1000)"));
    }
    let patch = args.get("patch").ok_or_else(|| anyhow!("manca 'patch'"))?;
    // `is_none_or` richiederebbe Rust 1.82, oltre l'MSRV dichiarato (1.77).
    if patch.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        return Err(anyhow!("'patch' deve essere un object non vuoto"));
    }
    let mut updated: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for code in &codes {
        let one = json!({ "code": code, "patch": patch });
        match article_update(&one) {
            Ok(_) => updated.push(code.clone()),
            Err(_) => missing.push(code.clone()),
        }
    }
    Ok(json!({
        "updated": updated.len(),
        "missing": missing,
        "text": format!(
            "Aggiornati {} articoli su {}.{}",
            updated.len(), codes.len(),
            if missing.is_empty() { String::new() }
            else { format!(" Non trovati: {}", missing.join(", ")) }
        ),
    }))
}

// ── documenti ──────────────────────────────────────────────────────────────

/// Crea un preventivo (quote) in archivio documenti.
pub fn document_create_quote(args: &Value) -> Result<Value> {
    create_document(args, "quote", "outgoing")
}

/// Crea un ordine cliente (incoming) o fornitore (outgoing).
pub fn document_create_order(args: &Value) -> Result<Value> {
    let direction = s(args, "direction").unwrap_or_else(|| "incoming".into());
    if !matches!(direction.as_str(), "incoming" | "outgoing") {
        return Err(anyhow!("'direction' deve essere 'incoming' o 'outgoing'"));
    }
    let doc_type = if direction == "incoming" {
        "sales_order"
    } else {
        "purchase_order"
    };
    create_document(args, doc_type, &direction)
}

fn create_document(args: &Value, doc_type: &str, direction: &str) -> Result<Value> {
    let customer_id = i(args, "customerId").ok_or_else(|| anyhow!("manca 'customerId'"))?;
    let doc_date = s(args, "docDate").ok_or_else(|| anyhow!("manca 'docDate' (YYYY-MM-DD)"))?;
    let items = ar(args, "items").cloned().unwrap_or_default();
    let cust = db::with_db(|c| db::anag::get_organization(c, customer_id))?
        .ok_or_else(|| anyhow!("partner id={customer_id} non trovato"))?;
    let articles = db::with_db(|c| db::anag::list_articles(c, 20_000, 0))?;

    let mut total = 0.0f64;
    let mut resolved: Vec<Value> = Vec::new();
    for it in items.iter() {
        let code = it
            .get("code")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("Ogni item richiede 'code'"))?;
        let qty = it.get("qty").and_then(|v| v.as_f64()).unwrap_or(1.0);
        let art = articles
            .iter()
            .find(|a| a.code.eq_ignore_ascii_case(code))
            .ok_or_else(|| anyhow!("articolo '{code}' non trovato"))?;
        // Prezzo: quello esplicito, altrimenti il motore prezzi del cliente
        // (override → sconti → listino), MAI il solo prezzo di listino base.
        let price = match it.get("unitPrice").and_then(|v| v.as_f64()) {
            Some(p) => p,
            None => db::with_db(|c| db::pricing::resolve_for_customer(c, customer_id, &art.code))
                .ok()
                .flatten()
                .and_then(|r| r.final_price)
                .or(art.sale_price)
                .unwrap_or(0.0),
        };
        let row_total = qty * price;
        total += row_total;
        resolved.push(json!({
            "articleId": art.id, "code": art.code, "description": art.description,
            "qty": qty, "unitPrice": price, "total": row_total,
        }));
    }

    let input = CustomerDocumentInput {
        id: None,
        organization_id: customer_id,
        direction: direction.to_string(),
        doc_type: doc_type.to_string(),
        doc_number: s(args, "docNumber"),
        doc_date: doc_date.clone(),
        status: None,
        total_amount: Some(total),
        currency: s(args, "currency"),
        message_id: i(args, "messageId"),
        attachment_filename: None,
        attachment_path: None,
        attachment_sha256: None,
        notes: s(args, "notes"),
    };
    let id = db::with_db(|c| db::crud::customer_document_upsert(c, &input))?;

    // Righe documento: la tabella `customer_document_items` non ha un
    // repository dedicato, le inseriamo qui in una sola transazione.
    if !resolved.is_empty() {
        db::with_db(|c| {
            let tx = c.transaction()?;
            for (idx, r) in resolved.iter().enumerate() {
                tx.execute(
                    "INSERT INTO customer_document_items
                        (document_id, article_id, code, description, quantity, unit_price, total, row_order)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![
                        id,
                        r.get("articleId").and_then(|v| v.as_i64()),
                        r.get("code").and_then(|v| v.as_str()),
                        r.get("description").and_then(|v| v.as_str()),
                        r.get("qty").and_then(|v| v.as_f64()).unwrap_or(1.0),
                        r.get("unitPrice").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        r.get("total").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        idx as i64,
                    ],
                )?;
            }
            tx.commit()?;
            Ok::<_, anyhow::Error>(())
        })?;
    }
    let name = cust.display_name.unwrap_or(cust.domain);
    Ok(json!({
        "id": id,
        "totalAmount": total,
        "text": format!(
            "Documento {doc_type} #{id} creato per «{name}» — {} righe, totale {total:.2}.",
            resolved.len()
        ),
    }))
}

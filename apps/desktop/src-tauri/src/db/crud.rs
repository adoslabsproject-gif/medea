//! CRUD per anagrafiche modificabili: articles, price_lists, price_list_items, contacts, organizations.

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

// ── Articles ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleInput {
    pub id: Option<i64>,
    pub code: String,
    pub description: String,
    pub unit: Option<String>,
    pub vat_percent: Option<f64>,
    pub notes: Option<String>,
    #[serde(default = "default_true")]
    pub is_active: bool,
    // v3 — gestionale
    pub brand_id: Option<i64>,
    pub category_id: Option<i64>,
    pub purchase_price: Option<f64>,
    pub sale_price: Option<f64>,
    pub currency: Option<String>,
    pub box_quantity: Option<i64>,
    pub country_of_origin: Option<String>,
    pub hs_code: Option<String>,
}

fn default_true() -> bool {
    true
}

pub fn article_upsert(conn: &Connection, a: &ArticleInput) -> Result<i64> {
    let now = Utc::now().to_rfc3339();
    if let Some(id) = a.id {
        conn.execute(
            "UPDATE articles SET
                code = ?1, description = ?2, unit = ?3,
                vat_percent = ?4, notes = ?5, is_active = ?6,
                brand_id = ?7, category_id = ?8,
                purchase_price = ?9, sale_price = ?10, currency = ?11,
                box_quantity = ?12, country_of_origin = ?13, hs_code = ?14,
                updated_at = ?15
             WHERE id = ?16",
            params![
                a.code,
                a.description,
                a.unit,
                a.vat_percent,
                a.notes,
                a.is_active as i32,
                a.brand_id,
                a.category_id,
                a.purchase_price,
                a.sale_price,
                a.currency.as_deref().unwrap_or("EUR"),
                a.box_quantity,
                a.country_of_origin,
                a.hs_code,
                now,
                id,
            ],
        )?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO articles (
                code, description, unit, vat_percent, notes, is_active,
                brand_id, category_id, purchase_price, sale_price, currency,
                box_quantity, country_of_origin, hs_code,
                created_at, updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)",
            params![
                a.code,
                a.description,
                a.unit,
                a.vat_percent,
                a.notes,
                a.is_active as i32,
                a.brand_id,
                a.category_id,
                a.purchase_price,
                a.sale_price,
                a.currency.as_deref().unwrap_or("EUR"),
                a.box_quantity,
                a.country_of_origin,
                a.hs_code,
                now,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn article_delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM articles WHERE id = ?1", params![id])?;
    Ok(())
}

// ── Price Lists ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceListInput {
    pub id: Option<i64>,
    pub name: String,
    pub organization_id: Option<i64>,
    #[serde(default)]
    pub is_default: bool,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub notes: Option<String>,
}

pub fn price_list_upsert(conn: &Connection, p: &PriceListInput) -> Result<i64> {
    let now = Utc::now().to_rfc3339();
    // se is_default → unset gli altri
    if p.is_default {
        conn.execute("UPDATE price_lists SET is_default = 0", [])?;
    }
    if let Some(id) = p.id {
        conn.execute(
            "UPDATE price_lists SET
                name = ?1, organization_id = ?2, is_default = ?3,
                valid_from = ?4, valid_to = ?5, notes = ?6, updated_at = ?7
             WHERE id = ?8",
            params![
                p.name,
                p.organization_id,
                p.is_default as i32,
                p.valid_from,
                p.valid_to,
                p.notes,
                now,
                id,
            ],
        )?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO price_lists (name, organization_id, is_default, valid_from, valid_to, notes, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
            params![
                p.name,
                p.organization_id,
                p.is_default as i32,
                p.valid_from,
                p.valid_to,
                p.notes,
                now,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn price_list_delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM price_lists WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceListItemInput {
    pub id: Option<i64>,
    pub price_list_id: i64,
    pub article_id: i64,
    pub price: f64,
    #[serde(default)]
    pub discount_percent: f64,
    pub notes: Option<String>,
}

pub fn price_list_item_upsert(conn: &Connection, i: &PriceListItemInput) -> Result<i64> {
    // unique (price_list_id, article_id) → upsert via ON CONFLICT
    conn.execute(
        "INSERT INTO price_list_items (price_list_id, article_id, price, discount_percent, notes)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(price_list_id, article_id) DO UPDATE SET
            price = excluded.price,
            discount_percent = excluded.discount_percent,
            notes = excluded.notes",
        params![
            i.price_list_id,
            i.article_id,
            i.price,
            i.discount_percent,
            i.notes
        ],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM price_list_items WHERE price_list_id = ?1 AND article_id = ?2",
        params![i.price_list_id, i.article_id],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub fn price_list_item_delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM price_list_items WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceListItemRow {
    pub id: i64,
    pub article_id: i64,
    pub article_code: String,
    pub article_description: String,
    pub article_unit: Option<String>,
    pub price: f64,
    pub discount_percent: f64,
    pub notes: Option<String>,
}

pub fn price_list_items(conn: &Connection, price_list_id: i64) -> Result<Vec<PriceListItemRow>> {
    let mut stmt = conn.prepare(
        "SELECT i.id, a.id, a.code, a.description, a.unit, i.price, i.discount_percent, i.notes
           FROM price_list_items i
           JOIN articles a ON a.id = i.article_id
          WHERE i.price_list_id = ?1
          ORDER BY a.code",
    )?;
    let rows = stmt
        .query_map(params![price_list_id], |r| {
            Ok(PriceListItemRow {
                id: r.get(0)?,
                article_id: r.get(1)?,
                article_code: r.get(2)?,
                article_description: r.get(3)?,
                article_unit: r.get(4)?,
                price: r.get(5)?,
                discount_percent: r.get(6)?,
                notes: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ── Contacts / Organizations: aggiornamento flag client/supplier + dati ─────

pub fn contact_set_flags(
    conn: &Connection,
    id: i64,
    is_client: bool,
    is_supplier: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE contacts SET is_client = ?1, is_supplier = ?2, updated_at = ?3 WHERE id = ?4",
        params![is_client as i32, is_supplier as i32, Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationUpdate {
    pub id: i64,
    pub display_name: Option<String>,
    pub vat_number: Option<String>,
    pub address: Option<String>,                    // legacy free-text
    pub phone: Option<String>,
    pub website: Option<String>,
    pub notes: Option<String>,
    pub is_client: bool,
    pub is_supplier: bool,
    // v3 — gestionale
    pub tax_code: Option<String>,
    pub sdi_code: Option<String>,
    pub pec: Option<String>,
    pub iban: Option<String>,
    pub bank_name: Option<String>,
    pub street_address: Option<String>,
    pub city: Option<String>,
    pub postal_code: Option<String>,
    pub province: Option<String>,
    pub country_iso2: Option<String>,
    pub preferred_courier: Option<String>,
    pub payment_terms: Option<String>,
    /// Enum: `porto_franco` | `porto_assegnato` | `franco_con_addebito`
    pub shipping_terms: Option<String>,
    pub preferred_language: Option<String>,
    pub email_address: Option<String>,
}

pub fn organization_update(conn: &Connection, o: &OrganizationUpdate) -> Result<()> {
    // CHECK constraint guard
    if let Some(s) = o.shipping_terms.as_deref() {
        if !matches!(s, "porto_franco" | "porto_assegnato" | "franco_con_addebito") {
            anyhow::bail!(
                "shipping_terms deve essere 'porto_franco' | 'porto_assegnato' | 'franco_con_addebito'"
            );
        }
    }
    conn.execute(
        "UPDATE organizations SET
            display_name = ?1, vat_number = ?2, address = ?3,
            phone = ?4, website = ?5, notes = ?6,
            is_client = ?7, is_supplier = ?8,
            tax_code = ?9, sdi_code = ?10, pec = ?11,
            iban = ?12, bank_name = ?13,
            street_address = ?14, city = ?15, postal_code = ?16,
            province = ?17, country_iso2 = ?18,
            preferred_courier = ?19, payment_terms = ?20,
            shipping_terms = ?21, preferred_language = ?22, email_address = ?23,
            updated_at = ?24
         WHERE id = ?25",
        params![
            o.display_name,
            o.vat_number,
            o.address,
            o.phone,
            o.website,
            o.notes,
            o.is_client as i32,
            o.is_supplier as i32,
            o.tax_code,
            o.sdi_code,
            o.pec,
            o.iban,
            o.bank_name,
            o.street_address,
            o.city,
            o.postal_code,
            o.province,
            o.country_iso2,
            o.preferred_courier,
            o.payment_terms,
            o.shipping_terms,
            o.preferred_language,
            o.email_address,
            Utc::now().to_rfc3339(),
            o.id,
        ],
    )?;
    Ok(())
}

/// Crea una nuova organizzazione "anagrafica" (cliente o fornitore).
/// Il `domain` può essere derivato dal `email_address`, ma per i clienti/fornitori
/// gestiti manualmente è opzionale (usiamo "manual:<rand>" come fallback).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationInsert {
    pub display_name: String,
    pub domain: Option<String>,
    pub email_address: Option<String>,
    #[serde(default)]
    pub is_client: bool,
    #[serde(default)]
    pub is_supplier: bool,
}

pub fn organization_insert(conn: &Connection, o: &OrganizationInsert) -> Result<i64> {
    let now = Utc::now().to_rfc3339();
    let domain = o.domain.clone().or_else(|| {
        o.email_address.as_ref().and_then(|e| {
            e.rsplit_once('@').map(|(_, d)| d.to_ascii_lowercase())
        })
    }).unwrap_or_else(|| format!("manual:{}", uuid_short()));
    conn.execute(
        "INSERT INTO organizations
            (domain, display_name, email_address, is_client, is_supplier, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(domain) DO UPDATE SET
            display_name = excluded.display_name,
            email_address = excluded.email_address,
            is_client    = MAX(organizations.is_client, excluded.is_client),
            is_supplier  = MAX(organizations.is_supplier, excluded.is_supplier),
            updated_at   = excluded.updated_at",
        params![
            domain,
            o.display_name,
            o.email_address,
            o.is_client as i32,
            o.is_supplier as i32,
            now,
        ],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM organizations WHERE domain = ?1",
        params![domain],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub fn organization_delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM organizations WHERE id = ?1", params![id])?;
    Ok(())
}

/// Aggiornamento atomico dei soli flag cliente/fornitore.
/// Più sicuro di `organization_update` quando vogliamo solo classificare:
/// non passa per CHECK constraint v3 sui campi inutilizzati.
pub fn organization_set_roles(
    conn: &Connection,
    id: i64,
    is_client: bool,
    is_supplier: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE organizations
            SET is_client = ?1, is_supplier = ?2, updated_at = ?3
          WHERE id = ?4",
        params![is_client as i32, is_supplier as i32, Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

fn uuid_short() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{ts:x}")
}

// ── Lookup brands / categories (read) ──────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandRow {
    pub id: i64,
    pub name: String,
    pub display_order: i64,
}

pub fn list_brands(conn: &Connection) -> Result<Vec<BrandRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, display_order FROM article_brands
          WHERE is_archived = 0
          ORDER BY display_order, name",
    )?;
    let rows = stmt
        .query_map([], |r| Ok(BrandRow {
            id: r.get(0)?,
            name: r.get(1)?,
            display_order: r.get(2)?,
        }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryRow {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub code: Option<String>,
    pub display_order: i64,
}

pub fn list_categories(conn: &Connection) -> Result<Vec<CategoryRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, name, code, display_order FROM article_categories
          WHERE is_archived = 0
          ORDER BY COALESCE(parent_id, 0), display_order, name",
    )?;
    let rows = stmt
        .query_map([], |r| Ok(CategoryRow {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            name: r.get(2)?,
            code: r.get(3)?,
            display_order: r.get(4)?,
        }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ── Sconti per cliente × categoria × marchio ──────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerDiscountInput {
    pub id: Option<i64>,
    pub customer_id: i64,
    pub category_id: Option<i64>,
    pub brand_id: Option<i64>,
    pub discount_pct: f64,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerDiscountRow {
    pub id: i64,
    pub customer_id: i64,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub brand_id: Option<i64>,
    pub brand_name: Option<String>,
    pub discount_pct: f64,
    pub notes: Option<String>,
}

pub fn customer_discount_upsert(conn: &Connection, d: &CustomerDiscountInput) -> Result<i64> {
    conn.execute(
        "INSERT INTO customer_category_discounts
            (customer_id, category_id, brand_id, discount_pct, notes, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT(customer_id, category_id, brand_id) DO UPDATE SET
             discount_pct = excluded.discount_pct,
             notes        = excluded.notes,
             updated_at   = excluded.updated_at",
        params![d.customer_id, d.category_id, d.brand_id, d.discount_pct, d.notes],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM customer_category_discounts
           WHERE customer_id = ?1
             AND COALESCE(category_id, -1) = COALESCE(?2, -1)
             AND COALESCE(brand_id,    -1) = COALESCE(?3, -1)",
        params![d.customer_id, d.category_id, d.brand_id],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub fn customer_discount_delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM customer_category_discounts WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn list_customer_discounts(conn: &Connection, customer_id: i64) -> Result<Vec<CustomerDiscountRow>> {
    let mut stmt = conn.prepare(
        "SELECT d.id, d.customer_id, d.category_id, c.name, d.brand_id, b.name,
                d.discount_pct, d.notes
           FROM customer_category_discounts d
           LEFT JOIN article_categories c ON c.id = d.category_id
           LEFT JOIN article_brands     b ON b.id = d.brand_id
          WHERE d.customer_id = ?1
          ORDER BY (d.category_id IS NULL), (d.brand_id IS NULL), c.name, b.name",
    )?;
    let rows = stmt
        .query_map(params![customer_id], |r| Ok(CustomerDiscountRow {
            id: r.get(0)?,
            customer_id: r.get(1)?,
            category_id: r.get(2)?,
            category_name: r.get(3)?,
            brand_id: r.get(4)?,
            brand_name: r.get(5)?,
            discount_pct: r.get(6)?,
            notes: r.get(7)?,
        }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ── Override prezzo cliente × articolo ────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerPriceOverrideInput {
    pub id: Option<i64>,
    pub customer_id: i64,
    pub article_id: i64,
    pub unit_price: f64,
    pub currency: Option<String>,
    pub notes: Option<String>,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerPriceOverrideRow {
    pub id: i64,
    pub customer_id: i64,
    pub article_id: i64,
    pub article_code: String,
    pub article_description: String,
    pub unit_price: f64,
    pub currency: String,
    pub notes: Option<String>,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
}

pub fn customer_price_override_upsert(
    conn: &Connection,
    o: &CustomerPriceOverrideInput,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO customer_price_overrides
            (customer_id, article_id, unit_price, currency, notes, valid_from, valid_to, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7, datetime('now'))
         ON CONFLICT(customer_id, article_id) DO UPDATE SET
             unit_price = excluded.unit_price,
             currency   = excluded.currency,
             notes      = excluded.notes,
             valid_from = excluded.valid_from,
             valid_to   = excluded.valid_to,
             updated_at = excluded.updated_at",
        params![
            o.customer_id,
            o.article_id,
            o.unit_price,
            o.currency.as_deref().unwrap_or("EUR"),
            o.notes,
            o.valid_from,
            o.valid_to,
        ],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM customer_price_overrides WHERE customer_id = ?1 AND article_id = ?2",
        params![o.customer_id, o.article_id],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub fn customer_price_override_delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM customer_price_overrides WHERE id = ?1", params![id])?;
    Ok(())
}

// ── Documenti cliente / fornitore ──────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerDocumentInput {
    pub id: Option<i64>,
    pub organization_id: i64,
    /// 'incoming' | 'outgoing'
    pub direction: String,
    /// uno dei 6 doc_type
    pub doc_type: String,
    pub doc_number: Option<String>,
    pub doc_date: String,
    pub status: Option<String>,
    pub total_amount: Option<f64>,
    pub currency: Option<String>,
    pub message_id: Option<i64>,
    pub attachment_filename: Option<String>,
    pub attachment_path: Option<String>,
    pub attachment_sha256: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomerDocumentRow {
    pub id: i64,
    pub organization_id: i64,
    pub direction: String,
    pub doc_type: String,
    pub doc_number: Option<String>,
    pub doc_date: String,
    pub status: Option<String>,
    pub total_amount: Option<f64>,
    pub currency: String,
    pub message_id: Option<i64>,
    pub attachment_filename: Option<String>,
    pub attachment_path: Option<String>,
    pub attachment_sha256: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub item_count: i64,
}

fn validate_doc_input(d: &CustomerDocumentInput) -> Result<()> {
    if !matches!(d.direction.as_str(), "incoming" | "outgoing") {
        anyhow::bail!("direction deve essere 'incoming' o 'outgoing'");
    }
    if !matches!(
        d.doc_type.as_str(),
        "sales_order" | "sales_confirm" | "quote"
            | "purchase_order" | "purchase_confirm" | "communication"
    ) {
        anyhow::bail!(
            "doc_type non valido (atteso: sales_order|sales_confirm|quote|purchase_order|purchase_confirm|communication)"
        );
    }
    Ok(())
}

pub fn customer_document_upsert(conn: &Connection, d: &CustomerDocumentInput) -> Result<i64> {
    validate_doc_input(d)?;
    if let Some(id) = d.id {
        conn.execute(
            "UPDATE customer_documents SET
                organization_id = ?1, direction = ?2, doc_type = ?3,
                doc_number = ?4, doc_date = ?5, status = ?6,
                total_amount = ?7, currency = ?8,
                message_id = ?9,
                attachment_filename = ?10, attachment_path = ?11, attachment_sha256 = ?12,
                notes = ?13, updated_at = datetime('now')
             WHERE id = ?14",
            params![
                d.organization_id,
                d.direction,
                d.doc_type,
                d.doc_number,
                d.doc_date,
                d.status,
                d.total_amount,
                d.currency.as_deref().unwrap_or("EUR"),
                d.message_id,
                d.attachment_filename,
                d.attachment_path,
                d.attachment_sha256,
                d.notes,
                id,
            ],
        )?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO customer_documents (
                organization_id, direction, doc_type,
                doc_number, doc_date, status,
                total_amount, currency,
                message_id, attachment_filename, attachment_path, attachment_sha256,
                notes, created_at, updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13, datetime('now'), datetime('now'))",
            params![
                d.organization_id,
                d.direction,
                d.doc_type,
                d.doc_number,
                d.doc_date,
                d.status,
                d.total_amount,
                d.currency.as_deref().unwrap_or("EUR"),
                d.message_id,
                d.attachment_filename,
                d.attachment_path,
                d.attachment_sha256,
                d.notes,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn customer_document_delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM customer_documents WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn list_customer_documents(
    conn: &Connection,
    organization_id: i64,
    doc_type: Option<&str>,
) -> Result<Vec<CustomerDocumentRow>> {
    let (sql, has_filter) = if doc_type.is_some() {
        (
            "SELECT d.id, d.organization_id, d.direction, d.doc_type,
                    d.doc_number, d.doc_date, d.status,
                    d.total_amount, COALESCE(d.currency,'EUR'),
                    d.message_id,
                    d.attachment_filename, d.attachment_path, d.attachment_sha256,
                    d.notes, d.created_at, d.updated_at,
                    (SELECT COUNT(*) FROM customer_document_items i WHERE i.document_id = d.id)
               FROM customer_documents d
              WHERE d.organization_id = ?1 AND d.doc_type = ?2
              ORDER BY d.doc_date DESC, d.id DESC",
            true,
        )
    } else {
        (
            "SELECT d.id, d.organization_id, d.direction, d.doc_type,
                    d.doc_number, d.doc_date, d.status,
                    d.total_amount, COALESCE(d.currency,'EUR'),
                    d.message_id,
                    d.attachment_filename, d.attachment_path, d.attachment_sha256,
                    d.notes, d.created_at, d.updated_at,
                    (SELECT COUNT(*) FROM customer_document_items i WHERE i.document_id = d.id)
               FROM customer_documents d
              WHERE d.organization_id = ?1
              ORDER BY d.doc_date DESC, d.id DESC",
            false,
        )
    };
    let mut stmt = conn.prepare(sql)?;
    let map = |r: &rusqlite::Row<'_>| -> rusqlite::Result<CustomerDocumentRow> {
        Ok(CustomerDocumentRow {
            id: r.get(0)?,
            organization_id: r.get(1)?,
            direction: r.get(2)?,
            doc_type: r.get(3)?,
            doc_number: r.get(4)?,
            doc_date: r.get(5)?,
            status: r.get(6)?,
            total_amount: r.get(7)?,
            currency: r.get(8)?,
            message_id: r.get(9)?,
            attachment_filename: r.get(10)?,
            attachment_path: r.get(11)?,
            attachment_sha256: r.get(12)?,
            notes: r.get(13)?,
            created_at: r.get(14)?,
            updated_at: r.get(15)?,
            item_count: r.get(16)?,
        })
    };
    let rows: Vec<CustomerDocumentRow> = if has_filter {
        stmt.query_map(params![organization_id, doc_type.unwrap()], map)?
            .collect::<rusqlite::Result<_>>()?
    } else {
        stmt.query_map(params![organization_id], map)?
            .collect::<rusqlite::Result<_>>()?
    };
    Ok(rows)
}

/// Riga documento con il nome del partner: usata dall'archivio globale.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocumentWithPartner {
    pub id: i64,
    pub organization_id: i64,
    pub organization_name: Option<String>,
    pub direction: String,
    pub doc_type: String,
    pub doc_number: Option<String>,
    pub doc_date: String,
    pub total_amount: Option<f64>,
    pub currency: String,
    pub notes: Option<String>,
    pub attachment_filename: Option<String>,
    pub attachment_path: Option<String>,
    pub item_count: i64,
}

/// Tutti i documenti archiviati, di ogni partner. Filtrabile per tipo.
pub fn list_all_documents(
    conn: &Connection,
    doc_type: Option<&str>,
    limit: u32,
) -> Result<Vec<DocumentWithPartner>> {
    let mut stmt = conn.prepare(
        "SELECT d.id, d.organization_id, COALESCE(o.display_name, o.domain),
                d.direction, d.doc_type, d.doc_number, d.doc_date,
                d.total_amount, COALESCE(d.currency,'EUR'), d.notes,
                d.attachment_filename, d.attachment_path,
                (SELECT COUNT(*) FROM customer_document_items i WHERE i.document_id = d.id)
           FROM customer_documents d
           LEFT JOIN organizations o ON o.id = d.organization_id
          WHERE (?1 IS NULL OR d.doc_type = ?1)
          ORDER BY d.doc_date DESC, d.id DESC
          LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![doc_type, limit], |r| {
            Ok(DocumentWithPartner {
                id: r.get(0)?,
                organization_id: r.get(1)?,
                organization_name: r.get(2)?,
                direction: r.get(3)?,
                doc_type: r.get(4)?,
                doc_number: r.get(5)?,
                doc_date: r.get(6)?,
                total_amount: r.get(7)?,
                currency: r.get(8)?,
                notes: r.get(9)?,
                attachment_filename: r.get(10)?,
                attachment_path: r.get(11)?,
                item_count: r.get(12)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn list_customer_price_overrides(
    conn: &Connection,
    customer_id: i64,
) -> Result<Vec<CustomerPriceOverrideRow>> {
    let mut stmt = conn.prepare(
        "SELECT o.id, o.customer_id, o.article_id, a.code, a.description,
                o.unit_price, COALESCE(o.currency,'EUR'), o.notes, o.valid_from, o.valid_to
           FROM customer_price_overrides o
           JOIN articles a ON a.id = o.article_id
          WHERE o.customer_id = ?1
          ORDER BY a.code",
    )?;
    let rows = stmt
        .query_map(params![customer_id], |r| Ok(CustomerPriceOverrideRow {
            id: r.get(0)?,
            customer_id: r.get(1)?,
            article_id: r.get(2)?,
            article_code: r.get(3)?,
            article_description: r.get(4)?,
            unit_price: r.get(5)?,
            currency: r.get(6)?,
            notes: r.get(7)?,
            valid_from: r.get(8)?,
            valid_to: r.get(9)?,
        }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

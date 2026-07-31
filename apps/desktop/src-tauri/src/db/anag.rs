//! Anagrafiche: contacts + organizations + articles + price_lists.
//! Solo lettura per ora (popolamento avviene dal sync per i contacts,
//! manualmente per articles/price_lists tramite la tab "Anagrafiche").

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContactRow {
    pub id: i64,
    pub email_address: String,
    pub display_name: Option<String>,
    pub organization_domain: Option<String>,
    pub organization_name: Option<String>,
    pub is_client: bool,
    pub is_supplier: bool,
    pub message_count: i64,
    pub last_seen_at: Option<String>,
}

pub fn list_contacts(conn: &Connection, limit: u32, offset: u32) -> Result<Vec<ContactRow>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.email_address, c.display_name,
                o.domain, o.display_name,
                c.is_client, c.is_supplier,
                c.message_count, c.last_seen_at
           FROM contacts c
           LEFT JOIN organizations o ON o.id = c.organization_id
          ORDER BY c.last_seen_at DESC NULLS LAST
          LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt
        .query_map(params![limit, offset], |r| {
            Ok(ContactRow {
                id: r.get(0)?,
                email_address: r.get(1)?,
                display_name: r.get(2)?,
                organization_domain: r.get(3)?,
                organization_name: r.get(4)?,
                is_client: r.get::<_, i64>(5)? != 0,
                is_supplier: r.get::<_, i64>(6)? != 0,
                message_count: r.get(7)?,
                last_seen_at: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationRow {
    pub id: i64,
    pub domain: String,
    pub display_name: Option<String>,
    pub vat_number: Option<String>,
    pub is_client: bool,
    pub is_supplier: bool,
    pub contact_count: i64,
    // v3 — riepilogo gestionale (utile in lista)
    pub city: Option<String>,
    pub country_iso2: Option<String>,
    pub email_address: Option<String>,
}

pub fn list_organizations(
    conn: &Connection,
    limit: u32,
    offset: u32,
) -> Result<Vec<OrganizationRow>> {
    let mut stmt = conn.prepare(
        "SELECT o.id, o.domain, o.display_name, o.vat_number, o.is_client, o.is_supplier,
                (SELECT COUNT(*) FROM contacts c WHERE c.organization_id = o.id) AS contact_count,
                o.city, o.country_iso2, o.email_address
           FROM organizations o
          ORDER BY contact_count DESC, o.display_name COLLATE NOCASE ASC
          LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt
        .query_map(params![limit, offset], |r| {
            Ok(OrganizationRow {
                id: r.get(0)?,
                domain: r.get(1)?,
                display_name: r.get(2)?,
                vat_number: r.get(3)?,
                is_client: r.get::<_, i64>(4)? != 0,
                is_supplier: r.get::<_, i64>(5)? != 0,
                contact_count: r.get(6)?,
                city: r.get(7)?,
                country_iso2: r.get(8)?,
                email_address: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Lista SOLO le organizzazioni che sono cliente o fornitore (l'anagrafica
/// gestionale, niente rubrica indirizzi).
pub fn list_business_partners(
    conn: &Connection,
    only_clients: bool,
    only_suppliers: bool,
) -> Result<Vec<OrganizationRow>> {
    let where_clause = match (only_clients, only_suppliers) {
        (true, false) => "WHERE o.is_client = 1",
        (false, true) => "WHERE o.is_supplier = 1",
        _ => "WHERE o.is_client = 1 OR o.is_supplier = 1",
    };
    let sql = format!(
        "SELECT o.id, o.domain, o.display_name, o.vat_number, o.is_client, o.is_supplier,
                (SELECT COUNT(*) FROM contacts c WHERE c.organization_id = o.id) AS contact_count,
                o.city, o.country_iso2, o.email_address
           FROM organizations o
          {where_clause}
          ORDER BY o.display_name COLLATE NOCASE ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(OrganizationRow {
                id: r.get(0)?,
                domain: r.get(1)?,
                display_name: r.get(2)?,
                vat_number: r.get(3)?,
                is_client: r.get::<_, i64>(4)? != 0,
                is_supplier: r.get::<_, i64>(5)? != 0,
                contact_count: r.get(6)?,
                city: r.get(7)?,
                country_iso2: r.get(8)?,
                email_address: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Scheda completa di un cliente/fornitore (tutti i campi gestionali v3).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationDetail {
    pub id: i64,
    pub domain: String,
    pub display_name: Option<String>,
    pub vat_number: Option<String>,
    pub tax_code: Option<String>,
    pub sdi_code: Option<String>,
    pub pec: Option<String>,
    pub email_address: Option<String>,
    pub phone: Option<String>,
    pub website: Option<String>,
    pub iban: Option<String>,
    pub bank_name: Option<String>,
    pub street_address: Option<String>,
    pub city: Option<String>,
    pub postal_code: Option<String>,
    pub province: Option<String>,
    pub country_iso2: Option<String>,
    pub preferred_courier: Option<String>,
    pub payment_terms: Option<String>,
    pub shipping_terms: Option<String>,
    pub preferred_language: Option<String>,
    pub notes: Option<String>,
    pub address: Option<String>, // legacy
    pub is_client: bool,
    pub is_supplier: bool,
    pub created_at: String,
    pub updated_at: String,
}

pub fn get_organization(conn: &Connection, id: i64) -> Result<Option<OrganizationDetail>> {
    use rusqlite::OptionalExtension;
    let row = conn
        .query_row(
            "SELECT id, domain, display_name, vat_number, tax_code, sdi_code, pec,
                    email_address, phone, website, iban, bank_name,
                    street_address, city, postal_code, province, country_iso2,
                    preferred_courier, payment_terms, shipping_terms, preferred_language,
                    notes, address, is_client, is_supplier, created_at, updated_at
               FROM organizations WHERE id = ?1",
            params![id],
            |r| {
                Ok(OrganizationDetail {
                    id: r.get(0)?,
                    domain: r.get(1)?,
                    display_name: r.get(2)?,
                    vat_number: r.get(3)?,
                    tax_code: r.get(4)?,
                    sdi_code: r.get(5)?,
                    pec: r.get(6)?,
                    email_address: r.get(7)?,
                    phone: r.get(8)?,
                    website: r.get(9)?,
                    iban: r.get(10)?,
                    bank_name: r.get(11)?,
                    street_address: r.get(12)?,
                    city: r.get(13)?,
                    postal_code: r.get(14)?,
                    province: r.get(15)?,
                    country_iso2: r.get(16)?,
                    preferred_courier: r.get(17)?,
                    payment_terms: r.get(18)?,
                    shipping_terms: r.get(19)?,
                    preferred_language: r.get(20)?,
                    notes: r.get(21)?,
                    address: r.get(22)?,
                    is_client: r.get::<_, i64>(23)? != 0,
                    is_supplier: r.get::<_, i64>(24)? != 0,
                    created_at: r.get(25)?,
                    updated_at: r.get(26)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArticleRow {
    pub id: i64,
    pub code: String,
    pub description: String,
    pub unit: Option<String>,
    pub vat_percent: Option<f64>,
    pub is_active: bool,
    /// Esposto perché il form di modifica lo deve preservare.
    pub notes: Option<String>,
    // v3 — gestionale
    pub brand_id: Option<i64>,
    pub brand_name: Option<String>,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub purchase_price: Option<f64>,
    pub sale_price: Option<f64>,
    pub currency: Option<String>,
    pub box_quantity: Option<i64>,
    pub country_of_origin: Option<String>,
    pub hs_code: Option<String>,
}

pub fn list_articles(conn: &Connection, limit: u32, offset: u32) -> Result<Vec<ArticleRow>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.code, a.description, a.unit, a.vat_percent, a.is_active,
                a.brand_id, b.name,
                a.category_id, c.name,
                a.purchase_price, a.sale_price, COALESCE(a.currency, 'EUR'),
                a.box_quantity, a.country_of_origin, a.hs_code, a.notes
           FROM articles a
           LEFT JOIN article_brands     b ON b.id = a.brand_id
           LEFT JOIN article_categories c ON c.id = a.category_id
          ORDER BY a.code COLLATE NOCASE ASC
          LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt
        .query_map(params![limit, offset], |r| {
            Ok(ArticleRow {
                id: r.get(0)?,
                code: r.get(1)?,
                description: r.get(2)?,
                unit: r.get(3)?,
                vat_percent: r.get(4)?,
                is_active: r.get::<_, i64>(5)? != 0,
                brand_id: r.get(6)?,
                brand_name: r.get(7)?,
                category_id: r.get(8)?,
                category_name: r.get(9)?,
                purchase_price: r.get(10)?,
                sale_price: r.get(11)?,
                currency: r.get(12)?,
                box_quantity: r.get(13)?,
                country_of_origin: r.get(14)?,
                hs_code: r.get(15)?,
                notes: r.get(16)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PriceListRow {
    pub id: i64,
    pub name: String,
    pub organization_id: Option<i64>,
    pub organization_name: Option<String>,
    pub is_default: bool,
    pub item_count: i64,
    // Esposti perché il form di modifica li deve poter preservare: senza,
    // ogni salvataggio dalla UI li azzerava.
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub notes: Option<String>,
}

pub fn list_price_lists(conn: &Connection) -> Result<Vec<PriceListRow>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.organization_id, o.display_name, p.is_default,
                (SELECT COUNT(*) FROM price_list_items i WHERE i.price_list_id = p.id) AS items,
                p.valid_from, p.valid_to, p.notes
           FROM price_lists p
           LEFT JOIN organizations o ON o.id = p.organization_id
          ORDER BY p.is_default DESC, p.name COLLATE NOCASE ASC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PriceListRow {
                id: r.get(0)?,
                name: r.get(1)?,
                organization_id: r.get(2)?,
                organization_name: r.get(3)?,
                is_default: r.get::<_, i64>(4)? != 0,
                item_count: r.get(5)?,
                valid_from: r.get(6)?,
                valid_to: r.get(7)?,
                notes: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

//! Motore di pricing deterministico Medea.
//!
//! Risolve il prezzo applicabile per `(customer, article)` con la seguente
//! priorità — la più SPECIFICA vince:
//!
//!   1. `customer_price_overrides`           → prezzo dedicato singolo (secco).
//!   2. `customer_category_discounts` su `(category, brand)`  → % sul sale_price.
//!   3. `customer_category_discounts` su `(category, brand=NULL)`.
//!   4. `customer_category_discounts` su `(category=NULL, brand)`.
//!   5. `customer_category_discounts` su `(category=NULL, brand=NULL)` (sconto base).
//!   6. Listino base: `articles.sale_price`.
//!
//! Nessuna inferenza, nessun guess: solo SQL. Funzione pura, niente effetti
//! collaterali → safe da esporre come tool deterministico all'AI.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceResolution {
    pub article_id: i64,
    pub article_code: String,
    pub article_description: String,
    pub customer_id: i64,
    pub list_price: Option<f64>,         // sale_price dell'articolo
    pub override_price: Option<f64>,     // se presente, è il prezzo finale (non scontato)
    pub discount_pct_applied: f64,       // 0 se nessuno
    pub discount_source: Option<String>, // "override" | "cat+brand" | "cat" | "brand" | "global" | null
    pub final_price: Option<f64>,        // calcolato; None se manca il listino e nessun override
    pub currency: String,
}

#[derive(Debug, Clone, Copy)]
struct DiscountRow {
    pct: f64,
    has_category: bool,
    has_brand: bool,
}

impl DiscountRow {
    fn specificity(&self) -> u8 {
        match (self.has_category, self.has_brand) {
            (true, true) => 4,   // cat+brand
            (true, false) => 3,  // cat
            (false, true) => 2,  // brand
            (false, false) => 1, // global
        }
    }
    fn source(&self) -> &'static str {
        match (self.has_category, self.has_brand) {
            (true, true) => "cat+brand",
            (true, false) => "cat",
            (false, true) => "brand",
            (false, false) => "global",
        }
    }
}

/// Riga articolo usata dal motore prezzi:
/// `(id, descrizione, prezzo di listino, brand_id, category_id, valuta)`.
type ArticlePricingRow = (i64, String, Option<f64>, Option<i64>, Option<i64>, String);

/// Risolve prezzo per (cliente, articolo per code). Cliente identificato per id.
pub fn resolve_for_customer(
    conn: &Connection,
    customer_id: i64,
    article_code: &str,
) -> Result<Option<PriceResolution>> {
    let row: Option<ArticlePricingRow> = conn
        .query_row(
            "SELECT id, description, sale_price, brand_id, category_id, COALESCE(currency, 'EUR')
               FROM articles
              WHERE code = ?1 AND is_active = 1",
            params![article_code],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()?;
    let Some((article_id, description, list_price, brand_id, category_id, currency)) = row else {
        return Ok(None);
    };

    // 1) Override secco.
    let override_price: Option<f64> = conn
        .query_row(
            "SELECT unit_price FROM customer_price_overrides
              WHERE customer_id = ?1 AND article_id = ?2
                AND (valid_from IS NULL OR valid_from <= date('now'))
                AND (valid_to   IS NULL OR valid_to   >= date('now'))",
            params![customer_id, article_id],
            |r| r.get::<_, f64>(0),
        )
        .optional()?;

    if let Some(p) = override_price {
        return Ok(Some(PriceResolution {
            article_id,
            article_code: article_code.to_string(),
            article_description: description,
            customer_id,
            list_price,
            override_price: Some(p),
            discount_pct_applied: 0.0,
            discount_source: Some("override".into()),
            final_price: Some(p),
            currency,
        }));
    }

    // 2) Sconto categoria/marchio — prendiamo TUTTE le regole compatibili e
    //    scegliamo la più specifica.
    let mut stmt = conn.prepare(
        "SELECT discount_pct, category_id, brand_id
           FROM customer_category_discounts
          WHERE customer_id = ?1
            AND (category_id IS NULL OR category_id = ?2)
            AND (brand_id    IS NULL OR brand_id    = ?3)",
    )?;
    let rows = stmt
        .query_map(params![customer_id, category_id, brand_id], |r| {
            let cat: Option<i64> = r.get(1)?;
            let br: Option<i64> = r.get(2)?;
            Ok(DiscountRow {
                pct: r.get(0)?,
                has_category: cat.is_some(),
                has_brand: br.is_some(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let best = rows.into_iter().max_by_key(|d| d.specificity());

    let (final_price, discount_pct, source) = match (list_price, best) {
        (Some(lp), Some(d)) => {
            let net = lp * (1.0 - d.pct / 100.0);
            (Some(net), d.pct, Some(d.source().to_string()))
        }
        (Some(lp), None) => (Some(lp), 0.0, None),
        (None, _) => (None, 0.0, None),
    };

    Ok(Some(PriceResolution {
        article_id,
        article_code: article_code.to_string(),
        article_description: description,
        customer_id,
        list_price,
        override_price: None,
        discount_pct_applied: discount_pct,
        discount_source: source,
        final_price,
        currency,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::ensure_schema;

    fn mk() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        ensure_schema(&c).unwrap();
        c
    }

    fn seed(c: &Connection) -> (i64, i64) {
        // Org cliente
        c.execute(
            "INSERT INTO organizations (domain, display_name, is_client, created_at, updated_at)
                   VALUES ('acme.test','ACME spa', 1, datetime('now'), datetime('now'))",
            [],
        )
        .unwrap();
        let cust_id = c.last_insert_rowid();

        // Articolo con brand=1 (Parker) e categoria=1 (Elettrovalvole)
        c.execute(
            "INSERT INTO articles (code, description, sale_price, brand_id, category_id, created_at, updated_at, is_active)
             VALUES ('EV-100', 'Elettrovalvola Parker', 100.0, 1, 1, datetime('now'), datetime('now'), 1)",
            []).unwrap();
        let art_id = c.last_insert_rowid();
        (cust_id, art_id)
    }

    #[test]
    fn list_price_only() {
        let c = mk();
        let (cust_id, _) = seed(&c);
        let r = resolve_for_customer(&c, cust_id, "EV-100")
            .unwrap()
            .unwrap();
        assert_eq!(r.final_price, Some(100.0));
        assert_eq!(r.discount_pct_applied, 0.0);
    }

    #[test]
    fn global_discount_applies() {
        let c = mk();
        let (cust_id, _) = seed(&c);
        c.execute(
            "INSERT INTO customer_category_discounts (customer_id, discount_pct) VALUES (?1, 10.0)",
            params![cust_id],
        )
        .unwrap();
        let r = resolve_for_customer(&c, cust_id, "EV-100")
            .unwrap()
            .unwrap();
        assert_eq!(r.discount_pct_applied, 10.0);
        assert_eq!(r.final_price, Some(90.0));
        assert_eq!(r.discount_source.as_deref(), Some("global"));
    }

    #[test]
    fn brand_beats_global() {
        let c = mk();
        let (cust_id, _) = seed(&c);
        c.execute(
            "INSERT INTO customer_category_discounts (customer_id, discount_pct) VALUES (?1, 5.0)",
            params![cust_id],
        )
        .unwrap();
        c.execute("INSERT INTO customer_category_discounts (customer_id, brand_id, discount_pct) VALUES (?1, 1, 15.0)",
                  params![cust_id]).unwrap();
        let r = resolve_for_customer(&c, cust_id, "EV-100")
            .unwrap()
            .unwrap();
        assert_eq!(r.discount_pct_applied, 15.0);
        assert_eq!(r.final_price, Some(85.0));
        assert_eq!(r.discount_source.as_deref(), Some("brand"));
    }

    #[test]
    fn cat_plus_brand_beats_cat() {
        let c = mk();
        let (cust_id, _) = seed(&c);
        c.execute("INSERT INTO customer_category_discounts (customer_id, category_id, discount_pct) VALUES (?1, 1, 12.0)",
                  params![cust_id]).unwrap();
        c.execute("INSERT INTO customer_category_discounts (customer_id, category_id, brand_id, discount_pct) VALUES (?1, 1, 1, 20.0)",
                  params![cust_id]).unwrap();
        let r = resolve_for_customer(&c, cust_id, "EV-100")
            .unwrap()
            .unwrap();
        assert_eq!(r.discount_pct_applied, 20.0);
        assert_eq!(r.final_price, Some(80.0));
        assert_eq!(r.discount_source.as_deref(), Some("cat+brand"));
    }

    #[test]
    fn override_beats_everything() {
        let c = mk();
        let (cust_id, art_id) = seed(&c);
        c.execute("INSERT INTO customer_category_discounts (customer_id, category_id, brand_id, discount_pct) VALUES (?1, 1, 1, 50.0)",
                  params![cust_id]).unwrap();
        c.execute("INSERT INTO customer_price_overrides (customer_id, article_id, unit_price) VALUES (?1, ?2, 42.5)",
                  params![cust_id, art_id]).unwrap();
        let r = resolve_for_customer(&c, cust_id, "EV-100")
            .unwrap()
            .unwrap();
        assert_eq!(r.override_price, Some(42.5));
        assert_eq!(r.final_price, Some(42.5));
        assert_eq!(r.discount_source.as_deref(), Some("override"));
    }

    #[test]
    fn unknown_article() {
        let c = mk();
        let (cust_id, _) = seed(&c);
        let r = resolve_for_customer(&c, cust_id, "NOPE").unwrap();
        assert!(r.is_none());
    }
}

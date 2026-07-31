//! Tier E — Analytics: SQL aggregati deterministici.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::db;

use super::helpers::{i, s};

/// Top clienti per fatturato/ordini/volume in un periodo.
pub fn analytics_top_customers(args: &Value) -> Result<Value> {
    let period = s(args, "period").unwrap_or_else(|| "year".into());
    let by = s(args, "by").unwrap_or_else(|| "amount".into());
    let limit = i(args, "limit").unwrap_or(10).clamp(1, 100) as u32;
    let (from, to) = resolve_period(&period)?;

    let agg = match by.as_str() {
        "amount" => "SUM(COALESCE(d.total_amount,0))",
        "orders" => "COUNT(d.id)",
        "volume" => "SUM(COALESCE((SELECT SUM(i.quantity) FROM customer_document_items i WHERE i.document_id = d.id),0))",
        other => return Err(anyhow!("'by' deve essere amount|orders|volume (passato: {other})")),
    };

    let sql = format!(
        "SELECT o.id, o.display_name, o.domain, {agg} AS metric, COUNT(d.id) AS docs
           FROM customer_documents d
           JOIN organizations o ON o.id = d.organization_id
          WHERE d.doc_date BETWEEN ?1 AND ?2
          GROUP BY o.id, o.display_name, o.domain
          ORDER BY metric DESC
          LIMIT ?3"
    );
    let rows = db::with_db(|c| {
        let mut stmt = c.prepare(&sql)?;
        let r: Vec<Value> = stmt
            .query_map(rusqlite::params![from, to, limit], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "displayName": r.get::<_, Option<String>>(1)?,
                    "domain": r.get::<_, String>(2)?,
                    "metric": r.get::<_, f64>(3)?,
                    "docCount": r.get::<_, i64>(4)?,
                }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok::<_, anyhow::Error>(r)
    })?;
    Ok(
        json!({ "period": period, "from": from, "to": to, "by": by, "count": rows.len(), "results": rows }),
    )
}

/// Top articoli per qty o amount in un periodo.
pub fn analytics_top_articles(args: &Value) -> Result<Value> {
    let period = s(args, "period").unwrap_or_else(|| "year".into());
    let by = s(args, "by").unwrap_or_else(|| "qty".into());
    let limit = i(args, "limit").unwrap_or(10).clamp(1, 100) as u32;
    let (from, to) = resolve_period(&period)?;

    let agg = match by.as_str() {
        "qty" => "SUM(COALESCE(i.quantity,0))",
        "amount" => "SUM(COALESCE(i.total, i.quantity * i.unit_price, 0))",
        other => return Err(anyhow!("'by' deve essere qty|amount (passato: {other})")),
    };

    let sql = format!(
        "SELECT a.id, a.code, a.description, {agg} AS metric, COUNT(DISTINCT d.id) AS docs
           FROM customer_document_items i
           JOIN customer_documents d ON d.id = i.document_id
           JOIN articles a ON a.id = i.article_id
          WHERE d.doc_date BETWEEN ?1 AND ?2
          GROUP BY a.id, a.code, a.description
          ORDER BY metric DESC
          LIMIT ?3"
    );
    let rows = db::with_db(|c| {
        let mut stmt = c.prepare(&sql)?;
        let r: Vec<Value> = stmt
            .query_map(rusqlite::params![from, to, limit], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "code": r.get::<_, String>(1)?,
                    "description": r.get::<_, String>(2)?,
                    "metric": r.get::<_, f64>(3)?,
                    "docCount": r.get::<_, i64>(4)?,
                }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok::<_, anyhow::Error>(r)
    })?;
    Ok(
        json!({ "period": period, "from": from, "to": to, "by": by, "count": rows.len(), "results": rows }),
    )
}

/// Volume email per giorno/settimana/mese.
pub fn analytics_email_volume(args: &Value) -> Result<Value> {
    let period = s(args, "period").unwrap_or_else(|| "year".into());
    let group_by = s(args, "groupBy").unwrap_or_else(|| "month".into());
    let (from, to) = resolve_period(&period)?;
    let bucket = match group_by.as_str() {
        "day" => "strftime('%Y-%m-%d', internal_date)",
        "week" => "strftime('%Y-%W',    internal_date)",
        "month" => "strftime('%Y-%m',    internal_date)",
        other => {
            return Err(anyhow!(
                "'groupBy' deve essere day|week|month (passato: {other})"
            ))
        }
    };
    let sql = format!(
        "SELECT {bucket} AS bucket, COUNT(*) AS n
           FROM messages
          WHERE is_local_deleted = 0
            AND internal_date IS NOT NULL
            AND date(internal_date) BETWEEN ?1 AND ?2
          GROUP BY bucket
          ORDER BY bucket"
    );
    let rows = db::with_db(|c| {
        let mut stmt = c.prepare(&sql)?;
        let r: Vec<(String, i64)> = stmt
            .query_map(rusqlite::params![from, to], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok::<_, anyhow::Error>(r)
    })?;
    let total: i64 = rows.iter().map(|(_, n)| n).sum();
    Ok(json!({
        "period": period, "from": from, "to": to, "groupBy": group_by,
        "totalCount": total, "buckets": rows.len(),
        "series": rows.iter().map(|(b, n)| json!({ "label": b, "value": n })).collect::<Vec<_>>()
    }))
}

/// Clienti silenti da N mesi: nessun documento E nessuna email scambiata.
pub fn analytics_customer_churn(args: &Value) -> Result<Value> {
    let months = i(args, "months").unwrap_or(6).clamp(1, 120);
    let cutoff = chrono::Local::now() - chrono::Duration::days(months * 30);
    let cutoff_iso = cutoff.format("%Y-%m-%d").to_string();

    let rows = db::with_db(|c| {
        let mut stmt = c.prepare(
            "SELECT o.id, o.display_name, o.domain,
                    MAX(d.doc_date) AS last_doc,
                    (SELECT MAX(m.internal_date) FROM messages m WHERE m.from_address LIKE '%@' || o.domain) AS last_msg
               FROM organizations o
               LEFT JOIN customer_documents d ON d.organization_id = o.id
              WHERE o.is_client = 1
              GROUP BY o.id, o.display_name, o.domain
             HAVING (MAX(d.doc_date) IS NULL OR MAX(d.doc_date) < ?1)
                AND ((SELECT MAX(m.internal_date) FROM messages m WHERE m.from_address LIKE '%@' || o.domain) IS NULL
                  OR (SELECT MAX(m.internal_date) FROM messages m WHERE m.from_address LIKE '%@' || o.domain) < ?1)
              ORDER BY last_doc DESC NULLS LAST
              LIMIT 200"
        )?;
        let r: Vec<Value> = stmt
            .query_map(rusqlite::params![cutoff_iso], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "displayName": r.get::<_, Option<String>>(1)?,
                    "domain": r.get::<_, String>(2)?,
                    "lastDocDate": r.get::<_, Option<String>>(3)?,
                    "lastMessageDate": r.get::<_, Option<String>>(4)?,
                }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok::<_, anyhow::Error>(r)
    })?;
    Ok(json!({ "months": months, "cutoff": cutoff_iso, "count": rows.len(), "results": rows }))
}

/// Risolve un periodo nominale → (fromDate, toDate) ISO.
/// Supporta: 'year' | 'last-year' | 'month' | 'last-month' | 'week' | 'q1-YYYY'..'q4-YYYY'
/// | 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD..YYYY-MM-DD'.
fn resolve_period(period: &str) -> Result<(String, String)> {
    use chrono::{Datelike, Duration, Local, NaiveDate};
    let today = Local::now().date_naive();
    let fmt = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    let year_start = |y: i32| NaiveDate::from_ymd_opt(y, 1, 1).unwrap();
    let year_end = |y: i32| NaiveDate::from_ymd_opt(y, 12, 31).unwrap();

    if period == "year" {
        return Ok((fmt(year_start(today.year())), fmt(year_end(today.year()))));
    }
    if period == "last-year" {
        return Ok((
            fmt(year_start(today.year() - 1)),
            fmt(year_end(today.year() - 1)),
        ));
    }
    if period == "month" {
        let start = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap();
        let end = if today.month() == 12 {
            NaiveDate::from_ymd_opt(today.year() + 1, 1, 1).unwrap() - Duration::days(1)
        } else {
            NaiveDate::from_ymd_opt(today.year(), today.month() + 1, 1).unwrap() - Duration::days(1)
        };
        return Ok((fmt(start), fmt(end)));
    }
    if period == "last-month" {
        let (ly, lm) = if today.month() == 1 {
            (today.year() - 1, 12)
        } else {
            (today.year(), today.month() - 1)
        };
        let start = NaiveDate::from_ymd_opt(ly, lm, 1).unwrap();
        let end = if lm == 12 {
            NaiveDate::from_ymd_opt(ly + 1, 1, 1).unwrap() - Duration::days(1)
        } else {
            NaiveDate::from_ymd_opt(ly, lm + 1, 1).unwrap() - Duration::days(1)
        };
        return Ok((fmt(start), fmt(end)));
    }
    if period == "week" {
        let weekday = today.weekday().num_days_from_monday() as i64;
        let start = today - Duration::days(weekday);
        return Ok((fmt(start), fmt(today)));
    }
    // q1-YYYY .. q4-YYYY
    if let Some(rest) = period
        .strip_prefix("q")
        .or_else(|| period.strip_prefix("Q"))
    {
        if let Some((q, y)) = rest.split_once('-') {
            if let (Ok(qn), Ok(yn)) = (q.parse::<u32>(), y.parse::<i32>()) {
                if (1..=4).contains(&qn) {
                    let start_m = (qn - 1) * 3 + 1;
                    let start = NaiveDate::from_ymd_opt(yn, start_m, 1).unwrap();
                    let next = if start_m + 3 > 12 {
                        NaiveDate::from_ymd_opt(yn + 1, 1, 1).unwrap()
                    } else {
                        NaiveDate::from_ymd_opt(yn, start_m + 3, 1).unwrap()
                    };
                    let end = next - Duration::days(1);
                    return Ok((fmt(start), fmt(end)));
                }
            }
        }
    }
    // YYYY-MM
    if let Some((y, m)) = period.split_once('-') {
        if let (Ok(yn), Ok(mn)) = (y.parse::<i32>(), m.parse::<u32>()) {
            if (1..=12).contains(&mn) {
                let start = NaiveDate::from_ymd_opt(yn, mn, 1).unwrap();
                let end = if mn == 12 {
                    NaiveDate::from_ymd_opt(yn + 1, 1, 1).unwrap() - Duration::days(1)
                } else {
                    NaiveDate::from_ymd_opt(yn, mn + 1, 1).unwrap() - Duration::days(1)
                };
                return Ok((fmt(start), fmt(end)));
            }
        }
    }
    // YYYY
    if let Ok(yn) = period.parse::<i32>() {
        return Ok((fmt(year_start(yn)), fmt(year_end(yn))));
    }
    Err(anyhow!("Periodo non riconosciuto: '{period}' (usa: year|last-year|month|last-month|week|q1-YYYY|YYYY|YYYY-MM)"))
}

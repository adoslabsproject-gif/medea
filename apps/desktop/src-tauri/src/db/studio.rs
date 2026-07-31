//! DB Studio: ispezione + CRUD generico sulle tabelle del DB Medea.
//!
//! - Discovery dinamica via `sqlite_master` (no più whitelist statica)
//! - Esclusione tabelle interne SQLite/FTS5 (prefisso `sqlite_`, `*_fts_*`)
//! - Validazione `table` contro la lista ammessa prima di ogni statement
//! - INSERT/UPDATE/DELETE con prepared statement, mai SQL composto da input.

use anyhow::{anyhow, Result};
use rusqlite::{types::Value as SqlValue, Connection, ToSql};
use serde::Serialize;
use serde_json::Value as Json;

/// Restituisce la lista delle tabelle "user" del DB (escluse sqlite_* e FTS interne).
fn enumerate_tables(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
            AND name NOT LIKE '%_fts_data'
            AND name NOT LIKE '%_fts_idx'
            AND name NOT LIKE '%_fts_docsize'
            AND name NOT LIKE '%_fts_config'
            AND name NOT LIKE '%_fts_content'
          ORDER BY name",
    )?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub row_count: i64,
    pub column_count: i64,
}

pub fn list_tables(conn: &Connection) -> Result<Vec<TableInfo>> {
    let names = enumerate_tables(conn)?;
    let mut out = Vec::with_capacity(names.len());
    for t in names {
        let cnt: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM \"{t}\""), [], |r| r.get(0))
            .unwrap_or(0);
        let cols: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_table_info(?1)", [&t], |r| {
                r.get(0)
            })
            .unwrap_or(0);
        out.push(TableInfo {
            name: t,
            row_count: cnt,
            column_count: cols,
        });
    }
    Ok(out)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub primary_key: bool,
}

pub fn describe_table(conn: &Connection, table: &str) -> Result<Vec<ColumnInfo>> {
    ensure_allowed(conn, table)?;
    let mut stmt =
        conn.prepare("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1)")?;
    let rows = stmt
        .query_map([table], |r| {
            Ok(ColumnInfo {
                name: r.get(0)?,
                data_type: r.get(1)?,
                nullable: r.get::<_, i64>(2)? == 0,
                default_value: r.get(3)?,
                primary_key: r.get::<_, i64>(4)? > 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Json>>,
    pub total: i64,
}

pub fn query_table(
    conn: &Connection,
    table: &str,
    limit: u32,
    offset: u32,
    filter: Option<&str>,
) -> Result<TablePage> {
    ensure_allowed(conn, table)?;
    let total: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| {
            r.get(0)
        })
        .unwrap_or(0);

    let col_names = column_names(conn, table)?;

    let mut sql = format!("SELECT * FROM \"{table}\"");
    let mut params_vec: Vec<String> = Vec::new();
    if let Some(f) = filter.filter(|s| !s.trim().is_empty()) {
        let pat = format!("%{}%", f.trim());
        let likes: Vec<String> = col_names
            .iter()
            .map(|c| format!("CAST(\"{c}\" AS TEXT) LIKE ?"))
            .collect();
        sql.push_str(" WHERE ");
        sql.push_str(&likes.join(" OR "));
        for _ in &col_names {
            params_vec.push(pat.clone());
        }
    }
    sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));

    let mut stmt = conn.prepare(&sql)?;
    let n = stmt.column_count();
    let rows_iter = stmt.query_map(rusqlite::params_from_iter(params_vec.iter()), |r| {
        let mut row = Vec::with_capacity(n);
        for i in 0..n {
            let v: SqlValue = r.get::<_, SqlValue>(i)?;
            row.push(value_to_json(&v));
        }
        Ok(row)
    })?;
    let rows: Vec<Vec<Json>> = rows_iter.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(TablePage {
        columns: col_names,
        rows,
        total,
    })
}

// ── CRUD generico ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CrudResult {
    pub ok: bool,
    pub rows_affected: i64,
    pub last_insert_rowid: Option<i64>,
}

/// INSERT su una tabella ammessa. `values` è un oggetto col→val.
/// Le colonne devono esistere nello schema. PK auto-increment va omessa.
pub fn row_insert(conn: &Connection, table: &str, values: &Json) -> Result<CrudResult> {
    ensure_allowed(conn, table)?;
    let cols_set = column_set(conn, table)?;
    let obj = values
        .as_object()
        .ok_or_else(|| anyhow!("'values' deve essere un oggetto"))?;
    if obj.is_empty() {
        return Err(anyhow!("Nessuna colonna da inserire"));
    }
    let mut cols_used: Vec<&String> = Vec::new();
    let mut params: Vec<JsonSql> = Vec::new();
    for (k, v) in obj {
        if !cols_set.contains(k.as_str()) {
            return Err(anyhow!("Colonna sconosciuta: {k}"));
        }
        cols_used.push(k);
        params.push(JsonSql(v.clone()));
    }
    let placeholders = (1..=cols_used.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let col_quoted = cols_used
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("INSERT INTO \"{table}\" ({col_quoted}) VALUES ({placeholders})");
    let affected = conn.execute(
        &sql,
        rusqlite::params_from_iter(params.iter().map(|p| p as &dyn ToSql)),
    )?;
    Ok(CrudResult {
        ok: true,
        rows_affected: affected as i64,
        last_insert_rowid: Some(conn.last_insert_rowid()),
    })
}

/// UPDATE di una riga identificata da (pk_col, pk_val). `patch` = col→nuovo val.
pub fn row_update(
    conn: &Connection,
    table: &str,
    pk_col: &str,
    pk_val: &Json,
    patch: &Json,
) -> Result<CrudResult> {
    ensure_allowed(conn, table)?;
    let cols_set = column_set(conn, table)?;
    if !cols_set.contains(pk_col) {
        return Err(anyhow!("PK column '{pk_col}' non esiste in {table}"));
    }
    let obj = patch
        .as_object()
        .ok_or_else(|| anyhow!("'patch' deve essere un oggetto"))?;
    if obj.is_empty() {
        return Err(anyhow!("Nessuna colonna da aggiornare"));
    }
    let mut sets: Vec<String> = Vec::new();
    let mut params: Vec<JsonSql> = Vec::new();
    for (k, v) in obj {
        if !cols_set.contains(k.as_str()) {
            return Err(anyhow!("Colonna sconosciuta: {k}"));
        }
        if k == pk_col {
            // Aggiornare la PK è permesso ma scelta esplicita: lo lasciamo passare.
        }
        sets.push(format!("\"{k}\" = ?"));
        params.push(JsonSql(v.clone()));
    }
    params.push(JsonSql(pk_val.clone()));
    let sql = format!(
        "UPDATE \"{table}\" SET {} WHERE \"{pk_col}\" = ?",
        sets.join(", ")
    );
    let affected = conn.execute(
        &sql,
        rusqlite::params_from_iter(params.iter().map(|p| p as &dyn ToSql)),
    )?;
    Ok(CrudResult {
        ok: affected > 0,
        rows_affected: affected as i64,
        last_insert_rowid: None,
    })
}

/// DELETE di una riga identificata da (pk_col, pk_val).
pub fn row_delete(
    conn: &Connection,
    table: &str,
    pk_col: &str,
    pk_val: &Json,
) -> Result<CrudResult> {
    ensure_allowed(conn, table)?;
    let cols_set = column_set(conn, table)?;
    if !cols_set.contains(pk_col) {
        return Err(anyhow!("PK column '{pk_col}' non esiste in {table}"));
    }
    let sql = format!("DELETE FROM \"{table}\" WHERE \"{pk_col}\" = ?");
    let affected = conn.execute(&sql, rusqlite::params![JsonSql(pk_val.clone())])?;
    Ok(CrudResult {
        ok: affected > 0,
        rows_affected: affected as i64,
        last_insert_rowid: None,
    })
}

// ── helpers ────────────────────────────────────────────────────────────

fn ensure_allowed(conn: &Connection, t: &str) -> Result<()> {
    if t.is_empty() || t.contains('"') || t.contains(';') {
        anyhow::bail!("Nome tabella non valido: {t}");
    }
    let tables = enumerate_tables(conn)?;
    if !tables.contains(&t.to_string()) {
        anyhow::bail!("Tabella non consentita o inesistente: {t}");
    }
    Ok(())
}

fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")?;
    let rows = stmt.query_map([table], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn column_set(conn: &Connection, table: &str) -> Result<std::collections::HashSet<String>> {
    Ok(column_names(conn, table)?.into_iter().collect())
}

fn value_to_json(v: &SqlValue) -> Json {
    match v {
        SqlValue::Null => Json::Null,
        SqlValue::Integer(i) => Json::from(*i),
        SqlValue::Real(f) => Json::from(*f),
        SqlValue::Text(s) => Json::from(s.clone()),
        SqlValue::Blob(b) => Json::from(format!("<blob {} bytes>", b.len())),
    }
}

/// Wrapper per passare un `serde_json::Value` come parametro SQLite.
struct JsonSql(Json);

impl ToSql for JsonSql {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        use rusqlite::types::{ToSqlOutput, Value as TV};
        let v = match &self.0 {
            Json::Null => TV::Null,
            Json::Bool(b) => TV::Integer(if *b { 1 } else { 0 }),
            Json::Number(n) => {
                if let Some(i) = n.as_i64() {
                    TV::Integer(i)
                } else if let Some(f) = n.as_f64() {
                    TV::Real(f)
                } else {
                    TV::Text(n.to_string())
                }
            }
            Json::String(s) => TV::Text(s.clone()),
            other => TV::Text(other.to_string()),
        };
        Ok(ToSqlOutput::Owned(v))
    }
}

/// Estrae nome della PK di una tabella (prima colonna con `pk > 0`), se esiste.
pub fn primary_key(conn: &Connection, table: &str) -> Result<Option<String>> {
    ensure_allowed(conn, table)?;
    let mut stmt = conn.prepare("SELECT name, pk FROM pragma_table_info(?1) ORDER BY cid")?;
    let rows: Vec<(String, i64)> = stmt
        .query_map([table], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows.into_iter().find(|(_, pk)| *pk > 0).map(|(n, _)| n))
}

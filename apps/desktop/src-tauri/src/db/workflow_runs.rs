//! Lo storico delle esecuzioni dei workflow.
//!
//! Un'esecuzione si legge sempre tutta insieme — «cosa è successo in questo
//! giro» — quindi i passi restano in una colonna JSON invece che in righe
//! separate: ricomporli a ogni apertura sarebbe lavoro inutile.
//!
//! L'elenco è la vista che si usa di più, e non deve caricare l'output di
//! ogni nodo di ogni esecuzione per mostrare una data e un esito: `list`
//! restituisce il riassunto, `get` il documento completo.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub workflow_id: i64,
    /// `pending` | `running` | `success` | `partial` | `error` | `paused` | `cancelled`
    pub status: String,
    pub trigger_type: Option<String>,
    pub trigger_payload_json: Option<String>,
    /// Un elemento per nodo eseguito, nella forma del runtime FlowForge.
    pub steps_json: String,
    pub error_count: i64,
    pub total_duration_ms: Option<i64>,
    pub triggered_by: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

/// La riga senza i passi: è quello che serve all'elenco.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub workflow_id: i64,
    pub status: String,
    pub trigger_type: Option<String>,
    pub error_count: i64,
    pub total_duration_ms: Option<i64>,
    pub step_count: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunInput {
    pub id: String,
    pub workflow_id: i64,
    pub status: String,
    pub trigger_type: Option<String>,
    pub trigger_payload_json: Option<String>,
    pub steps_json: Option<String>,
    pub error_count: Option<i64>,
    pub total_duration_ms: Option<i64>,
    pub triggered_by: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

const VALID_STATUS: [&str; 7] = [
    "pending",
    "running",
    "success",
    "partial",
    "error",
    "paused",
    "cancelled",
];

fn valid_status(raw: &str) -> &str {
    if VALID_STATUS.contains(&raw) {
        raw
    } else {
        "pending"
    }
}

/// Quanti nodi ha toccato l'esecuzione, senza deserializzare i passi in
/// strutture tipizzate: all'elenco serve solo un numero.
fn count_steps(steps_json: &str) -> i64 {
    serde_json::from_str::<serde_json::Value>(steps_json)
        .ok()
        .and_then(|v| v.as_array().map(Vec::len))
        .unwrap_or(0) as i64
}

pub fn list(conn: &Connection, workflow_id: i64, limit: i64) -> Result<Vec<RunSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, workflow_id, status, trigger_type, error_count, total_duration_ms,
                steps_json, started_at, ended_at
         FROM workflow_runs
         WHERE workflow_id = ?1
         ORDER BY started_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![workflow_id, limit], |r| {
        let steps: String = r.get(6)?;
        Ok(RunSummary {
            id: r.get(0)?,
            workflow_id: r.get(1)?,
            status: r.get(2)?,
            trigger_type: r.get(3)?,
            error_count: r.get(4)?,
            total_duration_ms: r.get(5)?,
            step_count: count_steps(&steps),
            started_at: r.get(7)?,
            ended_at: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<RunRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, workflow_id, status, trigger_type, trigger_payload_json, steps_json,
                error_count, total_duration_ms, triggered_by, started_at, ended_at
         FROM workflow_runs WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |r| {
        Ok(RunRow {
            id: r.get(0)?,
            workflow_id: r.get(1)?,
            status: r.get(2)?,
            trigger_type: r.get(3)?,
            trigger_payload_json: r.get(4)?,
            steps_json: r.get(5)?,
            error_count: r.get(6)?,
            total_duration_ms: r.get(7)?,
            triggered_by: r.get(8)?,
            started_at: r.get(9)?,
            ended_at: r.get(10)?,
        })
    })?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// Registra o aggiorna un'esecuzione. Un'esecuzione nasce `running` e viene
/// riscritta quando finisce: l'id lo decide chi la avvia.
pub fn upsert(conn: &Connection, run: &RunInput) -> Result<()> {
    let steps = run.steps_json.as_deref().unwrap_or("[]");
    serde_json::from_str::<serde_json::Value>(steps)
        .map_err(|e| anyhow::anyhow!("I passi non sono JSON valido: {e}"))?;

    conn.execute(
        "INSERT INTO workflow_runs
           (id, workflow_id, status, trigger_type, trigger_payload_json, steps_json,
            error_count, total_duration_ms, triggered_by, started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           steps_json = excluded.steps_json,
           error_count = excluded.error_count,
           total_duration_ms = excluded.total_duration_ms,
           ended_at = excluded.ended_at",
        params![
            run.id,
            run.workflow_id,
            valid_status(&run.status),
            run.trigger_type,
            run.trigger_payload_json,
            steps,
            run.error_count.unwrap_or(0),
            run.total_duration_ms,
            run.triggered_by,
            run.started_at,
            run.ended_at,
        ],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM workflow_runs WHERE id = ?1", params![id])?;
    Ok(())
}

/// Svuota lo storico di un workflow.
pub fn clear(conn: &Connection, workflow_id: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM workflow_runs WHERE workflow_id = ?1",
        params![workflow_id],
    )?)
}

//! Le automazioni disegnate sul canvas.
//!
//! Il grafo viaggia come stringa JSON opaca: qui non si interpreta, si
//! conserva. La forma del documento è definita dallo schema condiviso col
//! server (`features/workflows/types.ts`) e deve restare identica — un
//! workflow esportato da Medea si importa su FlowForge e viceversa.

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRow {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    /// Il documento completo, così com'è stato salvato.
    pub graph_json: String,
    /// `local` | `server`
    pub execution_target: String,
    pub enabled: bool,
    /// Come lo conosce il runtime, quando gli è già stato mandato.
    pub runtime_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// La riga senza il grafo: è quello che serve per l'elenco, e su una
/// mailbox con decine di automazioni evita di caricare tutti i documenti
/// per mostrare dei nomi.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummary {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub execution_target: String,
    pub enabled: bool,
    pub node_count: i64,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInput {
    /// Assente per un workflow nuovo, presente per un aggiornamento.
    pub id: Option<i64>,
    pub name: String,
    pub description: Option<String>,
    pub graph_json: String,
    pub execution_target: Option<String>,
    pub enabled: Option<bool>,
}

fn valid_target(raw: Option<&str>) -> &str {
    match raw {
        Some("server") => "server",
        _ => "local",
    }
}

/// Quanti nodi contiene il documento, senza deserializzarlo tutto in
/// strutture tipizzate: serve solo un numero per l'elenco.
fn count_nodes(graph_json: &str) -> i64 {
    serde_json::from_str::<serde_json::Value>(graph_json)
        .ok()
        .and_then(|v| v.get("nodes").and_then(|n| n.as_array().map(Vec::len)))
        .unwrap_or(0) as i64
}

pub fn list(conn: &Connection) -> Result<Vec<WorkflowSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, graph_json, execution_target, enabled, updated_at
         FROM workflows ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        let graph: String = r.get(3)?;
        Ok(WorkflowSummary {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            execution_target: r.get(4)?,
            enabled: r.get::<_, i64>(5)? != 0,
            node_count: count_nodes(&graph),
            updated_at: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Una riga della tabella nella forma con cui la usa il resto dell'app.
fn row_to_workflow(r: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowRow> {
    Ok(WorkflowRow {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        graph_json: r.get(3)?,
        execution_target: r.get(4)?,
        enabled: r.get::<_, i64>(5)? != 0,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        runtime_id: r.get(8)?,
    })
}

/// Il workflow che il runtime conosce con questo nome.
///
/// Serve a riconoscere le esecuzioni partite da sole: il runtime le annuncia
/// col suo identificativo, e senza questa ricerca finirebbero nel vuoto invece
/// che nello storico del workflow giusto.
pub fn by_runtime_id(conn: &Connection, runtime_id: &str) -> Result<Option<WorkflowRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, graph_json, execution_target, enabled, created_at, updated_at,
                runtime_id
         FROM workflows WHERE runtime_id = ?1",
    )?;
    let mut rows = stmt.query_map(params![runtime_id], row_to_workflow)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<WorkflowRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, graph_json, execution_target, enabled, created_at, updated_at,
                runtime_id
         FROM workflows WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], row_to_workflow)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// Inserisce o aggiorna, e restituisce l'id. Il documento non viene
/// validato qui: la validazione e il quality gate girano nel frontend prima
/// di arrivare a questo punto, ed è lì che il modello riceve i motivi del
/// rifiuto.
pub fn upsert(conn: &Connection, wf: &WorkflowInput) -> Result<i64> {
    let name = wf.name.trim();
    if name.is_empty() {
        anyhow::bail!("Il workflow deve avere un nome");
    }
    // Un JSON illeggibile qui sarebbe un documento perso: meglio scoprirlo
    // adesso che al prossimo caricamento.
    serde_json::from_str::<serde_json::Value>(&wf.graph_json)
        .map_err(|e| anyhow::anyhow!("Il grafo non è JSON valido: {e}"))?;

    let now = Utc::now().to_rfc3339();
    let target = valid_target(wf.execution_target.as_deref());
    let enabled = i64::from(wf.enabled.unwrap_or(false));

    if let Some(id) = wf.id {
        let changed = conn.execute(
            "UPDATE workflows
             SET name = ?2, description = ?3, graph_json = ?4,
                 execution_target = ?5, enabled = ?6, updated_at = ?7
             WHERE id = ?1",
            params![
                id,
                name,
                wf.description,
                wf.graph_json,
                target,
                enabled,
                now
            ],
        )?;
        if changed == 0 {
            anyhow::bail!("Il workflow {id} non esiste");
        }
        return Ok(id);
    }

    conn.execute(
        "INSERT INTO workflows
           (name, description, graph_json, execution_target, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![name, wf.description, wf.graph_json, target, enabled, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Ricorda con che nome il runtime conosce questo workflow.
pub fn set_runtime_id(conn: &Connection, id: i64, runtime_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE workflows SET runtime_id = ?2 WHERE id = ?1",
        params![id, runtime_id],
    )?;
    Ok(())
}

pub fn set_enabled(conn: &Connection, id: i64, enabled: bool) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE workflows SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, i64::from(enabled), now],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM workflows WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn duplicate(conn: &Connection, id: i64) -> Result<i64> {
    let source = get(conn, id)?.ok_or_else(|| anyhow::anyhow!("Il workflow {id} non esiste"))?;
    upsert(
        conn,
        &WorkflowInput {
            id: None,
            name: format!("{} (copia)", source.name),
            description: source.description,
            graph_json: source.graph_json,
            execution_target: Some(source.execution_target),
            // Una copia non parte da sola: l'utente decide quando attivarla.
            enabled: Some(false),
            // E non eredita il collegamento al runtime: e' un altro workflow,
            // e dovra' essergli mandato per conto suo.
        },
    )
}

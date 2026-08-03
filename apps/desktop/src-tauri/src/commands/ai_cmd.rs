//! AI chat multi-provider — BYOK: ogni provider usa la chiave dell'utente.
//! `custom` è un endpoint OpenAI-compatibile arbitrario (base URL + modello
//! configurati dall'utente), utile per vLLM/self-hosted/gateway privati.

use serde::Deserialize;

use serde::Serialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    /// `system` | `user` | `assistant` | `tool`
    pub role: String,
    pub content: String,
    /// Solo per `assistant`: tool-call emesse in quel turno (formato OpenAI).
    #[serde(default)]
    pub tool_calls: Option<Vec<serde_json::Value>>,
    /// Solo per `tool`: id della call a cui questo risultato risponde.
    #[serde(default)]
    pub tool_call_id: Option<String>,
    /// Solo per `tool`: nome del tool eseguito.
    #[serde(default)]
    pub name: Option<String>,
    /// Immagini allegate al turno, come data URL (`data:image/png;base64,…`).
    /// Vengono tradotte nel formato multimodale del provider.
    #[serde(default)]
    pub images: Option<Vec<String>>,
}

/// Spezza un data URL in (media_type, base64). `None` se non è un data URL.
fn split_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(",")?;
    let media = meta.split(';').next().unwrap_or("image/png");
    if !meta.contains("base64") {
        return None;
    }
    Some((media.to_string(), data.to_string()))
}

/// Una chiamata a tool emessa dal modello, normalizzata tra i provider.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallOut {
    pub id: String,
    pub name: String,
    /// Argomenti già deserializzati (mai la stringa JSON grezza).
    pub arguments: serde_json::Value,
}

/// Quanto è costata una risposta, quando il provider lo dice.
///
/// Non tutti lo dicono e non tutti lo chiamano allo stesso modo: OpenAI e i
/// compatibili usano `prompt_tokens`/`completion_tokens`, Anthropic
/// `input_tokens`/`output_tokens`. Chi non lo dice lascia il campo vuoto, e
/// l'interfaccia semplicemente non mostra il conto invece di inventarne uno.
#[derive(Debug, Serialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
}

/// Risposta del modello: testo e/o chiamate a tool.
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub content: String,
    pub tool_calls: Vec<ToolCallOut>,
    /// Quanti token sono serviti, se il provider lo dichiara.
    pub usage: Option<TokenUsage>,
}

/// Legge il conto dei token da una risposta, nei due nomi in cui si presenta.
fn parse_usage(json: &serde_json::Value) -> Option<TokenUsage> {
    let usage = json.get("usage")?;
    let leggi = |nomi: [&str; 2]| -> u64 {
        nomi.iter()
            .find_map(|n| usage.get(*n).and_then(serde_json::Value::as_u64))
            .unwrap_or(0)
    };
    let input = leggi(["prompt_tokens", "input_tokens"]);
    let output = leggi(["completion_tokens", "output_tokens"]);
    // Un conto a zero da entrambe le parti vuol dire che non c'era: meglio
    // niente che «0 token», che sarebbe una informazione falsa.
    if input == 0 && output == 0 {
        return None;
    }
    Some(TokenUsage { input, output })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider: String,
    pub system_prompt: String,
    pub history: Vec<ChatTurn>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Solo per provider `custom`: base URL OpenAI-compatibile
    /// (es. `https://miohost/v1`).
    #[serde(default)]
    pub base_url: Option<String>,
    /// Tool disponibili, in formato OpenAI
    /// (`[{type:"function", function:{name, description, parameters}}]`).
    #[serde(default)]
    pub tools: Option<Vec<serde_json::Value>>,
    /// Un nome per questa richiesta, se si vuole poterla fermare a metà.
    /// Chi non lo passa non può interromperla — e non ne ha bisogno.
    #[serde(default)]
    pub request_id: Option<String>,
}

/// Messaggi in formato OpenAI, inclusi i turni `assistant` con tool-call e i
/// turni `tool` con i risultati (è il protocollo su cui il modello è allenato).
fn openai_messages(req: &ChatRequest) -> Vec<serde_json::Value> {
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(req.history.len() + 1);
    if !req.system_prompt.trim().is_empty() {
        messages.push(serde_json::json!({"role": "system", "content": req.system_prompt}));
    }
    for t in &req.history {
        // Con immagini il content diventa un array di parti (formato vision
        // OpenAI): `[{type:"text"}, {type:"image_url", image_url:{url}}]`.
        let content = match t.images.as_ref().filter(|v| !v.is_empty()) {
            Some(images) => {
                let mut parts = vec![serde_json::json!({ "type": "text", "text": t.content })];
                for url in images {
                    parts.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": { "url": url },
                    }));
                }
                serde_json::Value::Array(parts)
            }
            None => serde_json::json!(t.content),
        };
        let mut m = serde_json::json!({ "role": t.role, "content": content });
        if let Some(calls) = &t.tool_calls {
            m["tool_calls"] = serde_json::json!(calls);
        }
        if let Some(id) = &t.tool_call_id {
            m["tool_call_id"] = serde_json::json!(id);
        }
        if let Some(name) = &t.name {
            m["name"] = serde_json::json!(name);
        }
        messages.push(m);
    }
    messages
}

/// Aggiunge `tools` + `tool_choice` al body se il chiamante li ha passati.
fn with_tools(mut body: serde_json::Value, req: &ChatRequest) -> serde_json::Value {
    if let Some(tools) = req.tools.as_ref().filter(|t| !t.is_empty()) {
        body["tools"] = serde_json::json!(tools);
        body["tool_choice"] = serde_json::json!("auto");
    }
    body
}

/// Recupera le tool-call che il modello ha scritto nel testo invece di usare
/// il canale nativo: `<tool_call>{"name":…,"arguments":{…}}</tool_call>`.
/// È il formato con cui i modelli fine-tuned in stile Liara sono addestrati.
fn tool_calls_from_text(content: &str) -> Vec<ToolCallOut> {
    let mut out = Vec::new();
    for (idx, chunk) in content.split("<tool_call>").skip(1).enumerate() {
        let Some(obj) = first_json_object(chunk) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&obj) else {
            continue;
        };
        let Some(name) = parsed.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let arguments = parsed
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        out.push(ToolCallOut {
            id: format!("text{idx:04}"),
            name: name.to_string(),
            arguments,
        });
    }
    out
}

/// Primo oggetto JSON bilanciato in una stringa (gestisce annidamento e stringhe).
fn first_json_object(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Estrae testo e tool-call da una risposta OpenAI-compatibile.
fn parse_openai_response(json: &serde_json::Value, label: &str) -> anyhow::Result<ChatResponse> {
    let msg = json
        .pointer("/choices/0/message")
        .ok_or_else(|| anyhow::anyhow!("{label}: risposta inattesa: {json}"))?;
    let content = msg
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let mut tool_calls: Vec<ToolCallOut> = Vec::new();
    if let Some(calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
        for (idx, c) in calls.iter().enumerate() {
            let name = c
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if name.is_empty() {
                continue;
            }
            // OpenAI serializza gli argomenti come STRINGA JSON.
            let arguments = match c.pointer("/function/arguments") {
                Some(serde_json::Value::String(s)) => {
                    serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!({}))
                }
                Some(v) => v.clone(),
                None => serde_json::json!({}),
            };
            let id = c
                .get("id")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("call{idx:04}"));
            tool_calls.push(ToolCallOut {
                id,
                name,
                arguments,
            });
        }
    }
    if tool_calls.is_empty() {
        tool_calls = tool_calls_from_text(&content);
    }
    Ok(ChatResponse {
        content,
        tool_calls,
        usage: parse_usage(json),
    })
}

#[tauri::command]
pub async fn ai_chat(req: ChatRequest) -> Result<ChatResponse, String> {
    // Chi vuole poter fermare la richiesta le dà un nome. Chi non lo fa —
    // le chiamate brevi, dove lo stop non ha senso — non paga niente.
    let token = req.request_id.as_deref().map(super::ai_abort::registra);
    let esito = ai_chat_interna(&req, token.clone()).await;
    if let Some(id) = req.request_id.as_deref() {
        super::ai_abort::dimentica(id);
    }
    esito
}

async fn ai_chat_interna(
    req: &ChatRequest,
    token: Option<tokio_util::sync::CancellationToken>,
) -> Result<ChatResponse, String> {
    let provider = req.provider.as_str();
    let chiamata = async {
        let result = match provider {
            "liara" => call_liara(req).await,
            "custom" => call_custom(req).await,
            "anthropic" => call_anthropic(req).await,
            "openai" => call_openai(req).await,
            "gemini" => call_gemini(req).await,
            "deepseek" => {
                call_openai_compat(
                    req,
                    "https://api.deepseek.com/v1/chat/completions",
                    "deepseek-chat",
                    "DEEPSEEK_API_KEY",
                    "DeepSeek",
                )
                .await
            }
            "grok" => {
                call_openai_compat(
                    req,
                    "https://api.x.ai/v1/chat/completions",
                    "grok-3-latest",
                    "XAI_API_KEY",
                    "Grok",
                )
                .await
            }
            "openrouter" => call_openrouter(req).await,
            other => Err(anyhow::anyhow!("Provider sconosciuto: {other}")),
        };
        result.map_err(|e| e.to_string())
    };

    // Con un interruttore associato, chi arriva primo vince: o la risposta, o
    // lo stop. Se vince lo stop la richiesta HTTP viene lasciata cadere qui, e
    // con essa la connessione: il provider se ne accorge e smette di generare.
    match token {
        Some(token) => {
            tokio::select! {
                esito = chiamata => esito,
                () = token.cancelled() => Err("Fermato su richiesta.".to_string()),
            }
        }
        None => chiamata.await,
    }
}

async fn call_openai_compat(
    req: &ChatRequest,
    endpoint: &str,
    default_model: &str,
    env_key: &str,
    label: &str,
) -> anyhow::Result<ChatResponse> {
    let key = req
        .api_key
        .clone()
        .or_else(|| std::env::var(env_key).ok())
        .ok_or_else(|| {
            anyhow::anyhow!("{label} richiede una API key (Impostazioni → Modelli AI)")
        })?;
    let body = with_tools(
        serde_json::json!({
            "model": req.model.as_deref().unwrap_or(default_model),
            "messages": openai_messages(req),
        }),
        req,
    );
    let resp = reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!("{label} HTTP {status}: {txt}");
    }
    let json: serde_json::Value = resp.json().await?;
    parse_openai_response(&json, label)
}

/// Gemini: niente tool-use nativo qui — le eventuali chiamate arrivano dal
/// fallback testuale `<tool_call>` (vedi `tool_calls_from_text`).
async fn call_gemini(req: &ChatRequest) -> anyhow::Result<ChatResponse> {
    let key = req
        .api_key
        .clone()
        .or_else(|| std::env::var("GEMINI_API_KEY").ok())
        .ok_or_else(|| {
            anyhow::anyhow!("Gemini richiede una API key (Impostazioni → Modelli AI)")
        })?;
    let model = req.model.as_deref().unwrap_or("gemini-2.5-pro");
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    );
    let contents: Vec<serde_json::Value> = req
        .history
        .iter()
        .map(|t| {
            let mut parts = vec![serde_json::json!({ "text": t.content })];
            // Formato vision di Gemini: `inline_data` con mime + base64.
            for url in t.images.iter().flatten() {
                if let Some((mime_type, data)) = split_data_url(url) {
                    parts.push(serde_json::json!({
                        "inline_data": { "mime_type": mime_type, "data": data },
                    }));
                }
            }
            serde_json::json!({
                "role": if t.role == "assistant" { "model" } else { "user" },
                "parts": parts,
            })
        })
        .collect();
    let body = serde_json::json!({
        "systemInstruction": { "parts": [{ "text": req.system_prompt }] },
        "contents": contents,
    });
    let resp = reqwest::Client::new().post(&url).json(&body).send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!("Gemini HTTP {status}: {txt}");
    }
    let json: serde_json::Value = resp.json().await?;
    let content = json
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Gemini: risposta inattesa"))?
        .to_string();
    let tool_calls = tool_calls_from_text(&content);
    Ok(ChatResponse {
        content,
        tool_calls,
        usage: parse_usage(&json),
    })
}

/// Liara — endpoint OpenAI-compatibile del modello proprio (`nha-v1`).
/// Resta BYOK: la chiave è dell'utente, l'URL e il modello sono i default noti
/// e restano sovrascrivibili da `baseUrl` / `model`.
async fn call_liara(req: &ChatRequest) -> anyhow::Result<ChatResponse> {
    const LIARA_BASE_URL: &str = "https://liara.nothumanallowed.com/v1";
    const LIARA_MODEL: &str = "nha-v1";

    let base_url = req
        .base_url
        .as_deref()
        .map(|u| u.trim_end_matches('/'))
        .filter(|u| !u.is_empty())
        .unwrap_or(LIARA_BASE_URL);
    let model = req
        .model
        .as_deref()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or(LIARA_MODEL);

    let body = with_tools(
        serde_json::json!({
            "model": model,
            "max_tokens": 8192,
            "messages": openai_messages(req),
            "stream": false,
            "chat_template_kwargs": { "enable_thinking": false },
        }),
        req,
    );
    post_openai_compatible(req, &format!("{base_url}/chat/completions"), &body, "Liara").await
}

/// POST a un endpoint OpenAI-compatibile con connessione fresca e un retry.
/// Le chiamate sono rare ma grosse: una connessione zombie nel pool si
/// manifesterebbe come "error sending request" all'utente.
async fn post_openai_compatible(
    req: &ChatRequest,
    url: &str,
    body: &serde_json::Value,
    label: &str,
) -> anyhow::Result<ChatResponse> {
    const MAX_ATTEMPTS: u32 = 2;
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .pool_max_idle_per_host(0)
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()?;
        let mut builder = client.post(url).json(body);
        if let Some(key) = req.api_key.as_deref().filter(|k| !k.is_empty()) {
            builder = builder.bearer_auth(key);
        }
        let resp = match builder.send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    "{label} attempt {}/{} network error: {}",
                    attempt,
                    MAX_ATTEMPTS,
                    e
                );
                last_err = Some(anyhow::anyhow!(
                    "{label}: rete fallita ({}): {e}. Riprova.",
                    classify_reqwest_err(&e)
                ));
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    continue;
                }
                break;
            }
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let txt = resp.text().await.unwrap_or_default();
            anyhow::bail!("{label} HTTP {status}: {txt}");
        }
        let json: serde_json::Value = resp.json().await?;
        return parse_openai_response(&json, label);
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("{label}: invio fallito senza causa nota")))
}

/// Endpoint OpenAI-compatibile configurato dall'utente (BYOK).
/// Richiede `baseUrl` e `model`; `apiKey` è opzionale (endpoint privati
/// senza auth, es. vLLM in LAN).
async fn call_custom(req: &ChatRequest) -> anyhow::Result<ChatResponse> {
    let base_url = req
        .base_url
        .as_deref()
        .map(|u| u.trim_end_matches('/'))
        .filter(|u| !u.is_empty())
        .ok_or_else(|| anyhow::anyhow!(
            "Endpoint personalizzato non configurato: imposta la base URL in Impostazioni → Modelli AI"
        ))?;
    let model = req
        .model
        .as_deref()
        .filter(|m| !m.trim().is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Modello non configurato per l'endpoint personalizzato (Impostazioni → Modelli AI)"
            )
        })?;

    let body = with_tools(
        serde_json::json!({
            "model": model,
            "max_tokens": 8192,
            "messages": openai_messages(req),
            "stream": false,
        }),
        req,
    );

    post_openai_compatible(
        req,
        &format!("{base_url}/chat/completions"),
        &body,
        "Endpoint personalizzato",
    )
    .await
}

fn classify_reqwest_err(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else if e.is_request() {
        "request build"
    } else if e.is_body() {
        "body"
    } else {
        "altro"
    }
}

/// Anthropic: tool-use nativo con schema proprio (`input_schema`, blocchi
/// `tool_use` / `tool_result`).
async fn call_anthropic(req: &ChatRequest) -> anyhow::Result<ChatResponse> {
    let key = req
        .api_key
        .clone()
        .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
        .ok_or_else(|| {
            anyhow::anyhow!("Anthropic richiede una API key (Impostazioni → Modelli AI)")
        })?;

    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(req.history.len());
    for t in &req.history {
        match t.role.as_str() {
            "tool" => {
                // Il risultato di un tool è un blocco `tool_result` in un turno user.
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": t.tool_call_id.clone().unwrap_or_default(),
                        "content": t.content,
                    }],
                }));
            }
            "assistant" if t.tool_calls.is_some() => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if !t.content.trim().is_empty() {
                    blocks.push(serde_json::json!({ "type": "text", "text": t.content }));
                }
                for c in t.tool_calls.iter().flatten() {
                    let args = match c.pointer("/function/arguments") {
                        Some(serde_json::Value::String(s)) => {
                            serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!({}))
                        }
                        Some(v) => v.clone(),
                        None => serde_json::json!({}),
                    };
                    blocks.push(serde_json::json!({
                        "type": "tool_use",
                        "id": c.get("id").and_then(|v| v.as_str()).unwrap_or("call"),
                        "name": c.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or(""),
                        "input": args,
                    }));
                }
                messages.push(serde_json::json!({ "role": "assistant", "content": blocks }));
            }
            role => {
                // Formato vision di Anthropic: blocchi `image` con source base64.
                match t.images.as_ref().filter(|v| !v.is_empty()) {
                    Some(images) => {
                        let mut blocks: Vec<serde_json::Value> = Vec::new();
                        for url in images {
                            if let Some((media_type, data)) = split_data_url(url) {
                                blocks.push(serde_json::json!({
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": media_type,
                                        "data": data,
                                    },
                                }));
                            }
                        }
                        blocks.push(serde_json::json!({ "type": "text", "text": t.content }));
                        messages.push(serde_json::json!({ "role": role, "content": blocks }));
                    }
                    None => {
                        messages.push(serde_json::json!({ "role": role, "content": t.content }));
                    }
                }
            }
        }
    }

    let mut body = serde_json::json!({
        "model": req.model.as_deref().unwrap_or("claude-sonnet-5"),
        "max_tokens": 4096,
        "system": req.system_prompt,
        "messages": messages,
    });
    if let Some(tools) = req.tools.as_ref().filter(|t| !t.is_empty()) {
        let converted: Vec<serde_json::Value> = tools
            .iter()
            .filter_map(|t| t.get("function"))
            .map(|f| {
                serde_json::json!({
                    "name": f.get("name"),
                    "description": f.get("description"),
                    "input_schema": f.get("parameters"),
                })
            })
            .collect();
        body["tools"] = serde_json::json!(converted);
    }

    let resp = reqwest::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!("Anthropic HTTP {status}: {txt}");
    }
    let json: serde_json::Value = resp.json().await?;
    let blocks = json
        .get("content")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("Anthropic: risposta inattesa: {json}"))?;
    let mut content = String::new();
    let mut tool_calls: Vec<ToolCallOut> = Vec::new();
    for b in blocks {
        match b.get("type").and_then(|v| v.as_str()) {
            Some("text") => content.push_str(b.get("text").and_then(|v| v.as_str()).unwrap_or("")),
            Some("tool_use") => tool_calls.push(ToolCallOut {
                id: b
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("call")
                    .to_string(),
                name: b
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                arguments: b
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            }),
            _ => {}
        }
    }
    if tool_calls.is_empty() {
        tool_calls = tool_calls_from_text(&content);
    }
    Ok(ChatResponse {
        content,
        tool_calls,
        usage: parse_usage(&json),
    })
}

async fn call_openai(req: &ChatRequest) -> anyhow::Result<ChatResponse> {
    call_openai_compat(
        req,
        "https://api.openai.com/v1/chat/completions",
        "gpt-4o",
        "OPENAI_API_KEY",
        "OpenAI",
    )
    .await
}

async fn call_openrouter(req: &ChatRequest) -> anyhow::Result<ChatResponse> {
    let key = req
        .api_key
        .clone()
        .or_else(|| std::env::var("OPENROUTER_API_KEY").ok())
        .ok_or_else(|| {
            anyhow::anyhow!("OpenRouter richiede una API key (Impostazioni → Modelli AI)")
        })?;
    let body = with_tools(
        serde_json::json!({
            "model": req.model.as_deref().unwrap_or("anthropic/claude-sonnet-4.5"),
            "messages": openai_messages(req),
        }),
        req,
    );
    let resp = reqwest::Client::new()
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(key)
        .header("X-Title", "Medea")
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!("OpenRouter HTTP {status}: {txt}");
    }
    let json: serde_json::Value = resp.json().await?;
    parse_openai_response(&json, "OpenRouter")
}

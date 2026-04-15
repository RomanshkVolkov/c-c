use std::time::Instant;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Head,
    Options,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<KeyValue>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<KeyValue>,
    pub body: String,
    pub size_bytes: usize,
    pub elapsed_ms: u128,
}

pub async fn execute(req: HttpRequest) -> Result<HttpResponse, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let method: reqwest::Method = match req.method {
        HttpMethod::Get => reqwest::Method::GET,
        HttpMethod::Post => reqwest::Method::POST,
        HttpMethod::Put => reqwest::Method::PUT,
        HttpMethod::Patch => reqwest::Method::PATCH,
        HttpMethod::Delete => reqwest::Method::DELETE,
        HttpMethod::Head => reqwest::Method::HEAD,
        HttpMethod::Options => reqwest::Method::OPTIONS,
    };

    let mut builder = client.request(method, &req.url);

    for h in &req.headers {
        if h.enabled && !h.key.is_empty() {
            builder = builder.header(&h.key, &h.value);
        }
    }

    if let Some(body) = &req.body {
        builder = builder.body(body.clone());
    }

    let start = Instant::now();
    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let elapsed_ms = start.elapsed().as_millis();

    let status = resp.status().as_u16();
    let status_text = resp.status().canonical_reason().unwrap_or("").to_string();

    let headers: Vec<KeyValue> = resp
        .headers()
        .iter()
        .map(|(k, v)| KeyValue {
            key: k.to_string(),
            value: v.to_str().unwrap_or("<binary>").to_string(),
            enabled: true,
        })
        .collect();

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let size_bytes = bytes.len();
    let body = String::from_utf8_lossy(&bytes).to_string();

    Ok(HttpResponse {
        status,
        status_text,
        headers,
        body,
        size_bytes,
        elapsed_ms,
    })
}

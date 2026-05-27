use crate::error::{AppError, AppResult};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::PathBuf;
use sysinfo::System;
use tauri::{AppHandle, Manager};

const OLLAMA_LIBRARY_URL: &str = "https://ollama.com/library";

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelRecommendation {
    pub id: String,
    pub purpose: String,
    pub size_gb: f32,
    pub min_ram_gb: f32,
    pub description: String,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaCatalogEntry {
    pub id: String,
    pub family: String,
    pub display_name: String,
    pub publisher: String,
    pub params: f32,
    pub disk_gb: f32,
    pub min_ram_gb: f32,
    pub recommended_ram_gb: f32,
    pub context_tokens: u32,
    pub quantization: String,
    pub categories: Vec<String>,
    pub primary_category: String,
    pub license: String,
    pub description: String,
    pub strengths: Vec<String>,
    pub weaknesses: Vec<String>,
    pub quality_rank: u32,
    pub popularity_rank: u32,
    pub source: String,
    pub tags: Vec<String>,
    pub pulls: Option<String>,
    pub updated: Option<String>,
    pub input_types: Vec<String>,
    pub upstream: bool,
}

#[derive(Debug)]
struct LibraryFamily {
    name: String,
    description: String,
    capabilities: Vec<String>,
    sizes: Vec<String>,
    pulls: Option<String>,
    updated: Option<String>,
    popularity_rank: u32,
}

#[tauri::command]
pub async fn system_memory_gb() -> AppResult<f32> {
    let mut sys = System::new();
    sys.refresh_memory();
    let bytes = sys.total_memory();
    Ok((bytes as f32) / (1024.0 * 1024.0 * 1024.0))
}

#[tauri::command]
pub async fn recommend_models() -> AppResult<Vec<ModelRecommendation>> {
    let mut sys = System::new();
    sys.refresh_memory();
    let total_gb = (sys.total_memory() as f32) / (1024.0 * 1024.0 * 1024.0);

    let candidates = vec![
        ModelRecommendation {
            id: "qwen2.5-coder:1.5b-base".into(),
            purpose: "fim".into(),
            size_gb: 1.0,
            min_ram_gb: 4.0,
            description: "Tiny FIM model for tab completion. Very fast.".into(),
            recommended: total_gb >= 4.0,
        },
        ModelRecommendation {
            id: "qwen2.5-coder:3b-base".into(),
            purpose: "fim".into(),
            size_gb: 2.0,
            min_ram_gb: 6.0,
            description: "Higher-quality FIM tab completion.".into(),
            recommended: total_gb >= 16.0,
        },
        ModelRecommendation {
            id: "qwen2.5-coder:7b-instruct".into(),
            purpose: "chat".into(),
            size_gb: 4.4,
            min_ram_gb: 8.0,
            description: "Capable chat & inline edit for 8-16GB machines.".into(),
            recommended: (8.0..24.0).contains(&total_gb),
        },
        ModelRecommendation {
            id: "qwen2.5-coder:14b-instruct".into(),
            purpose: "chat".into(),
            size_gb: 8.5,
            min_ram_gb: 16.0,
            description: "Strong chat / inline edit. Sweet spot for 16-32GB.".into(),
            recommended: (16.0..48.0).contains(&total_gb),
        },
        ModelRecommendation {
            id: "qwen2.5-coder:32b-instruct".into(),
            purpose: "chat".into(),
            size_gb: 19.0,
            min_ram_gb: 32.0,
            description: "Top-tier reasoning. Best on 32GB+.".into(),
            recommended: total_gb >= 32.0,
        },
        ModelRecommendation {
            id: "deepseek-coder-v2:16b".into(),
            purpose: "chat".into(),
            size_gb: 8.9,
            min_ram_gb: 16.0,
            description: "Alternative chat / agent model with strong refactoring.".into(),
            recommended: total_gb >= 16.0,
        },
        ModelRecommendation {
            id: "nomic-embed-text".into(),
            purpose: "embed".into(),
            size_gb: 0.3,
            min_ram_gb: 2.0,
            description: "Small embedding model for the codebase index.".into(),
            recommended: true,
        },
    ];

    Ok(candidates)
}

/// Fetch the public Ollama library and translate the family + size chips into
/// installable model tags. Ollama does not currently expose a documented JSON
/// catalog endpoint for the public library; the local documented APIs still
/// handle installed models and pulls.
#[tauri::command]
pub async fn ollama_library_catalog(app: AppHandle) -> AppResult<Vec<OllamaCatalogEntry>> {
    match fetch_ollama_library_catalog().await {
        Ok(entries) if !entries.is_empty() => {
            if let Err(e) = write_catalog_cache(&app, &entries) {
                log::warn!("ollama library cache write failed: {e}");
            }
            Ok(entries)
        }
        Ok(_) => read_catalog_cache(&app)
            .ok_or_else(|| AppError::Msg("Ollama library returned no models.".into())),
        Err(e) => {
            log::warn!("ollama library fetch failed: {e}");
            read_catalog_cache(&app).ok_or_else(|| {
                AppError::Msg(format!(
                    "Couldn't fetch Ollama's model library and no cached catalog is available: {e}"
                ))
            })
        }
    }
}

async fn fetch_ollama_library_catalog() -> AppResult<Vec<OllamaCatalogEntry>> {
    let html = reqwest::Client::new()
        .get(OLLAMA_LIBRARY_URL)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;

    let families = parse_library_families(&html)?;
    let mut entries = Vec::new();
    for family in families {
        entries.extend(entries_for_family(&family));
    }

    let mut seen = BTreeSet::new();
    entries.retain(|entry| seen.insert(entry.id.clone()));
    Ok(entries)
}

fn parse_library_families(html: &str) -> AppResult<Vec<LibraryFamily>> {
    let block_re = Regex::new(r#"(?s)<li\b[^>]*\bx-test-model\b[^>]*>.*?</li>"#)
        .map_err(|e| AppError::Msg(format!("library parser: {e}")))?;
    let title_tag_re = Regex::new(r#"(?s)<[^>]*\bx-test-model-title\b[^>]*>"#)
        .map_err(|e| AppError::Msg(format!("library parser: {e}")))?;
    let title_attr_re = Regex::new(r#"\btitle="([^"]+)""#)
        .map_err(|e| AppError::Msg(format!("library parser: {e}")))?;
    let desc_re = Regex::new(r#"(?s)<p\b[^>]*class="[^"]*max-w-lg[^"]*"[^>]*>(.*?)</p>"#)
        .map_err(|e| AppError::Msg(format!("library parser: {e}")))?;
    let pull_re = Regex::new(r#"(?s)<span\b[^>]*\bx-test-pull-count\b[^>]*>(.*?)</span>"#)
        .map_err(|e| AppError::Msg(format!("library parser: {e}")))?;
    let updated_re = Regex::new(r#"(?s)<span\b[^>]*\bx-test-updated\b[^>]*>(.*?)</span>"#)
        .map_err(|e| AppError::Msg(format!("library parser: {e}")))?;

    let mut families = Vec::new();
    for (idx, block) in block_re.find_iter(html).enumerate() {
        let block = block.as_str();
        let title_tag = title_tag_re.find(block).map(|m| m.as_str()).unwrap_or("");
        let Some(name) = title_attr_re
            .captures(title_tag)
            .and_then(|c| c.get(1))
            .map(|m| html_decode(m.as_str()).trim().to_string())
        else {
            continue;
        };
        if name.is_empty() || name.contains('/') {
            continue;
        }

        let description = desc_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| clean_html_text(m.as_str()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Model family from the Ollama library: {name}."));

        let capabilities = span_values(block, "x-test-capability");
        let sizes = span_values(block, "x-test-size");
        let pulls = pull_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| clean_html_text(m.as_str()))
            .filter(|s| !s.is_empty());
        let updated = updated_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| clean_html_text(m.as_str()))
            .filter(|s| !s.is_empty());

        families.push(LibraryFamily {
            name,
            description,
            capabilities,
            sizes,
            pulls,
            updated,
            popularity_rank: (idx + 1) as u32,
        });
    }

    Ok(families)
}

fn span_values(block: &str, attr: &str) -> Vec<String> {
    let pattern = format!(
        r#"(?s)<span\b[^>]*\b{}\b[^>]*>(.*?)</span>"#,
        regex::escape(attr),
    );
    let Ok(re) = Regex::new(&pattern) else {
        return Vec::new();
    };
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for cap in re.captures_iter(block) {
        if let Some(m) = cap.get(1) {
            let value = clean_html_text(m.as_str()).to_lowercase();
            if !value.is_empty() && seen.insert(value.clone()) {
                out.push(value);
            }
        }
    }
    out
}

fn entries_for_family(family: &LibraryFamily) -> Vec<OllamaCatalogEntry> {
    let mut specs: Vec<(String, Option<String>)> = Vec::new();
    if family.sizes.is_empty() {
        if family.capabilities.iter().any(|c| c == "cloud") {
            return Vec::new();
        }
        specs.push(("latest".into(), None));
    } else {
        for size in &family.sizes {
            specs.push((size.clone(), Some(size.clone())));
        }
    }

    specs
        .into_iter()
        .filter_map(|(tag, size)| entry_for_family_tag(family, &tag, size.as_deref()))
        .collect()
}

fn entry_for_family_tag(
    family: &LibraryFamily,
    tag: &str,
    size_hint: Option<&str>,
) -> Option<OllamaCatalogEntry> {
    let id = if tag == "latest" {
        format!("{}:latest", family.name)
    } else {
        format!("{}:{tag}", family.name)
    };
    let params = size_hint
        .and_then(parse_param_size)
        .or_else(|| parse_param_size(tag))
        .unwrap_or_else(|| {
            if family.capabilities.iter().any(|c| c == "embedding") {
                0.3
            } else {
                7.0
            }
        });
    if params <= 0.0 {
        return None;
    }

    let quantization = "Q4_K_M".to_string();
    let (disk_gb, min_ram_gb, recommended_ram_gb) = estimate_footprint(params, &quantization);
    let categories = infer_categories(&family.name, &family.description, &family.capabilities, &id);
    let primary_category = infer_primary_category(&categories);
    let mut tags = BTreeSet::new();
    tags.insert("ollama".to_string());
    tags.insert("upstream".to_string());
    tags.insert(family.name.to_lowercase());
    tags.insert(tag.to_lowercase());
    for c in &family.capabilities {
        tags.insert(c.to_lowercase());
    }
    for c in &categories {
        tags.insert(c.to_lowercase());
    }
    for word in family
        .name
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
    {
        tags.insert(word.to_lowercase());
    }

    Some(OllamaCatalogEntry {
        id,
        family: family.name.clone(),
        display_name: display_name(&family.name, tag),
        publisher: infer_publisher(&family.name),
        params,
        disk_gb,
        min_ram_gb,
        recommended_ram_gb,
        context_tokens: infer_context_tokens(&family.name, &family.description, &categories),
        quantization,
        categories,
        primary_category,
        license: "Ollama library".into(),
        description: family.description.clone(),
        strengths: strengths_for_family(family),
        weaknesses: Vec::new(),
        quality_rank: family.popularity_rank,
        popularity_rank: family.popularity_rank,
        source: "ollama".into(),
        tags: tags.into_iter().collect(),
        pulls: family.pulls.clone(),
        updated: family.updated.clone(),
        input_types: input_types_for_family(&family.capabilities),
        upstream: true,
    })
}

fn parse_param_size(raw: &str) -> Option<f32> {
    let s = raw
        .trim()
        .trim_start_matches('e')
        .trim_start_matches('E')
        .to_lowercase();
    let re = Regex::new(r#"(?:(\d+(?:\.\d+)?)x)?(\d+(?:\.\d+)?)([bm])"#).ok()?;
    let cap = re.captures(&s)?;
    let multiplier = cap
        .get(1)
        .and_then(|m| m.as_str().parse::<f32>().ok())
        .unwrap_or(1.0);
    let value = cap.get(2)?.as_str().parse::<f32>().ok()?;
    let unit = cap.get(3)?.as_str();
    let billions = if unit == "m" { value / 1000.0 } else { value };
    Some((billions * multiplier * 100.0).round() / 100.0)
}

fn estimate_footprint(params_b: f32, quant: &str) -> (f32, f32, f32) {
    let bpp = match quant.to_ascii_uppercase().as_str() {
        "Q2_K" => 0.4,
        "Q3_K_M" => 0.5,
        "Q4_0" => 0.55,
        "Q4_K_M" => 0.6,
        "Q5_K_M" => 0.7,
        "Q6_K" => 0.82,
        "Q8_0" => 1.06,
        "FP16" | "BF16" => 2.0,
        _ => 0.6,
    };
    let disk = round2(params_b * bpp);
    let min = round_half_up(disk * 1.25 + 0.8);
    let rec = round_half_up(min * 1.6);
    (disk, min, rec)
}

fn infer_categories(
    family: &str,
    description: &str,
    capabilities: &[String],
    id: &str,
) -> Vec<String> {
    let mut cats = BTreeSet::new();
    let hay = format!(
        "{} {} {} {}",
        family.to_lowercase(),
        description.to_lowercase(),
        capabilities.join(" ").to_lowercase(),
        id.to_lowercase()
    );

    cats.insert("chat".to_string());
    cats.insert("inlineEdit".to_string());

    if hay.contains("embedding") || hay.contains("embed") {
        cats.clear();
        cats.insert("indexing".to_string());
    }
    if hay.contains("vision") || hay.contains("multimodal") || hay.contains("ocr") {
        cats.insert("vision".to_string());
    }
    if hay.contains("document")
        || hay.contains("pdf")
        || hay.contains("ocr")
        || hay.contains("table")
        || hay.contains("chart")
    {
        cats.insert("document".to_string());
    }
    if hay.contains("tools")
        || hay.contains("tool")
        || hay.contains("agent")
        || hay.contains("reasoning")
        || hay.contains("thinking")
        || hay.contains("coder")
        || hay.contains("code")
    {
        cats.insert("agent".to_string());
    }
    if (hay.contains("coder") || hay.contains("code") || hay.contains("completion"))
        && (id.contains("-base") || hay.contains("fill-in-the-middle") || hay.contains("fim"))
    {
        cats.insert("fim".to_string());
    }

    cats.into_iter().collect()
}

fn infer_primary_category(categories: &[String]) -> String {
    for preferred in [
        "indexing",
        "fim",
        "vision",
        "document",
        "agent",
        "chat",
        "inlineEdit",
    ] {
        if categories.iter().any(|c| c == preferred) {
            return preferred.to_string();
        }
    }
    "chat".into()
}

fn infer_context_tokens(family: &str, description: &str, categories: &[String]) -> u32 {
    let hay = format!("{} {}", family.to_lowercase(), description.to_lowercase());
    if categories.iter().any(|c| c == "indexing") {
        return 8192;
    }
    if hay.contains("128k") || hay.contains("128 k") {
        return 131_072;
    }
    if hay.contains("64k") || hay.contains("64 k") {
        return 65_536;
    }
    if hay.contains("32k") || hay.contains("32 k") || family.contains("qwen") {
        return 32_768;
    }
    8192
}

fn input_types_for_family(capabilities: &[String]) -> Vec<String> {
    let mut out = vec!["Text".to_string()];
    if capabilities.iter().any(|c| c == "vision") {
        out.push("Image".to_string());
    }
    if capabilities.iter().any(|c| c == "audio") {
        out.push("Audio".to_string());
    }
    out
}

fn strengths_for_family(family: &LibraryFamily) -> Vec<String> {
    let mut strengths = Vec::new();
    if let Some(pulls) = &family.pulls {
        strengths.push(format!("{pulls} pulls on Ollama"));
    }
    if !family.capabilities.is_empty() {
        strengths.push(format!("Ollama tags: {}", family.capabilities.join(", ")));
    }
    if strengths.is_empty() {
        strengths.push("Listed in the public Ollama model library".into());
    }
    strengths
}

fn infer_publisher(family: &str) -> String {
    let f = family.to_lowercase();
    if f.contains("qwen") {
        "Qwen".into()
    } else if f.contains("deepseek") {
        "DeepSeek".into()
    } else if f.contains("llama") {
        "Meta".into()
    } else if f.contains("gemma") {
        "Google".into()
    } else if f.contains("mistral")
        || f.contains("mixtral")
        || f.contains("codestral")
        || f.contains("devstral")
    {
        "Mistral AI".into()
    } else if f.contains("phi") {
        "Microsoft".into()
    } else if f.contains("granite") {
        "IBM".into()
    } else if f.contains("nomic") {
        "Nomic AI".into()
    } else if f.contains("bge") {
        "BAAI".into()
    } else if f.contains("snowflake") {
        "Snowflake".into()
    } else if f.contains("openai") || f.contains("gpt-oss") {
        "OpenAI".into()
    } else {
        "Ollama".into()
    }
}

fn display_name(family: &str, tag: &str) -> String {
    let family_name = family
        .split(['-', '_'])
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut chars = s.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if tag == "latest" {
        family_name
    } else {
        format!("{family_name} {tag}")
    }
}

fn clean_html_text(s: &str) -> String {
    let tag_re = Regex::new(r#"(?s)<[^>]+>"#).expect("valid tag regex");
    let stripped = tag_re.replace_all(s, " ");
    html_decode(&stripped)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn html_decode(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

fn round2(n: f32) -> f32 {
    (n * 100.0).round() / 100.0
}

fn round_half_up(n: f32) -> f32 {
    (n * 2.0).round() / 2.0
}

fn catalog_cache_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Msg(format!("app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("ollama_library_catalog.json"))
}

fn write_catalog_cache(app: &AppHandle, entries: &[OllamaCatalogEntry]) -> AppResult<()> {
    let path = catalog_cache_path(app)?;
    let bytes = serde_json::to_vec(entries)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

fn read_catalog_cache(app: &AppHandle) -> Option<Vec<OllamaCatalogEntry>> {
    let path = catalog_cache_path(app).ok()?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_library_families_handles_ollama_cards_and_attr_order() {
        let html = r#"
        <ul>
          <li class="card" data-x="1" x-test-model>
            <div class="title" title="qwen2.5-coder" x-test-model-title></div>
            <p class="text-sm max-w-lg">Code model &amp; tool use.</p>
            <span class="chip" x-test-capability>tools</span>
            <span class="chip" x-test-size>1.5b</span>
            <span class="chip" x-test-size>7b</span>
            <span x-test-pull-count>16M</span>
            <span class="muted" x-test-updated>12 months ago</span>
          </li>
          <li class="card" x-test-model>
            <div x-test-model-title title="nomic-embed-text"></div>
            <p class="max-w-lg">Text embeddings for search.</p>
            <span x-test-capability class="chip">embedding</span>
            <span x-test-pull-count class="muted">71.6M</span>
          </li>
        </ul>
        "#;

        let families = parse_library_families(html).expect("parse library cards");

        assert_eq!(families.len(), 2);
        assert_eq!(families[0].name, "qwen2.5-coder");
        assert_eq!(families[0].description, "Code model & tool use.");
        assert_eq!(families[0].capabilities, vec!["tools"]);
        assert_eq!(families[0].sizes, vec!["1.5b", "7b"]);
        assert_eq!(families[0].pulls.as_deref(), Some("16M"));
        assert_eq!(families[0].updated.as_deref(), Some("12 months ago"));
        assert_eq!(families[1].name, "nomic-embed-text");
        assert_eq!(families[1].capabilities, vec!["embedding"]);
        assert!(families[1].sizes.is_empty());
    }

    #[test]
    fn entries_for_family_expands_sizes_and_embedding_latest() {
        let coder = LibraryFamily {
            name: "qwen2.5-coder".into(),
            description: "Code model with tools and fill-in-the-middle completions.".into(),
            capabilities: vec!["tools".into()],
            sizes: vec!["1.5b".into(), "7b".into()],
            pulls: Some("16M".into()),
            updated: Some("12 months ago".into()),
            popularity_rank: 12,
        };
        let embed = LibraryFamily {
            name: "nomic-embed-text".into(),
            description: "Text embedding model.".into(),
            capabilities: vec!["embedding".into()],
            sizes: vec![],
            pulls: None,
            updated: None,
            popularity_rank: 3,
        };

        let coder_entries = entries_for_family(&coder);
        let embed_entries = entries_for_family(&embed);

        assert_eq!(
            coder_entries
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["qwen2.5-coder:1.5b", "qwen2.5-coder:7b",]
        );
        assert!(coder_entries[0].categories.iter().any(|c| c == "agent"));
        assert!(coder_entries[0].categories.iter().any(|c| c == "fim"));
        assert_eq!(coder_entries[0].primary_category, "fim");
        assert_eq!(coder_entries[0].pulls.as_deref(), Some("16M"));
        assert_eq!(embed_entries.len(), 1);
        assert_eq!(embed_entries[0].id, "nomic-embed-text:latest");
        assert_eq!(embed_entries[0].categories, vec!["indexing"]);
        assert_eq!(embed_entries[0].input_types, vec!["Text"]);
    }

    #[test]
    fn parse_param_size_supports_common_ollama_size_chips() {
        assert_eq!(parse_param_size("270m"), Some(0.27));
        assert_eq!(parse_param_size("1.5b"), Some(1.5));
        assert_eq!(parse_param_size("8x7b"), Some(56.0));
        assert_eq!(parse_param_size("e5m"), Some(0.01));
        assert_eq!(parse_param_size("latest"), None);
    }

    #[test]
    fn estimate_footprint_is_conservative_and_stable() {
        let (disk, min, rec) = estimate_footprint(7.0, "Q4_K_M");
        assert_eq!(disk, 4.2);
        assert_eq!(min, 6.0);
        assert_eq!(rec, 9.5);
    }
}

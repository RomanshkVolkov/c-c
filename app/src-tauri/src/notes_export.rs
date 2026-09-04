//! Writes the whole notes tree out as a plain folder of `.md` files.
//!
//! This is the module that makes "I stopped using Notion" safe to say. Notes
//! live on a server the user runs, which is only an improvement over a SaaS if
//! leaving *this* one is also possible — so the export has to produce something
//! readable with no cac, no backend and no network: real directories, real
//! markdown, and the images sitting next to it rather than as links into an
//! API that would 404 the moment the server goes away.
//!
//! It runs in Rust rather than the webview for the same reason `open_attachment`
//! does: fetching an attachment needs the session token in a header, and the
//! bytes never have to cross the IPC bridge to reach the disk.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Where downloaded attachments go, relative to the export root.
const ATTACHMENT_DIR: &str = "_attachments";

/// Cap on a generated file name, leaving room for the `-2` dedupe suffix and a
/// deep path around it. Long titles are common ("Chapter 3 — everything about…")
/// and some filesystems still cap a single component at 255 bytes.
const MAX_STEM: usize = 80;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    id: String,
    note_id: String,
    url: String,
    #[serde(default)]
    file_name: String,
}

#[derive(Deserialize)]
struct ExportPayload {
    #[serde(default)]
    notes: Vec<Note>,
    #[serde(default)]
    attachments: Vec<Attachment>,
}

#[derive(Deserialize)]
struct Envelope {
    data: Option<ExportPayload>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub pages: usize,
    pub attachments: usize,
    /// How many attachments could not be downloaded. Reported rather than
    /// swallowed: an export that quietly dropped an image is worse than one
    /// that says so, because the user only finds out when they need it.
    pub failed_attachments: usize,
    pub dir: String,
}

/// Filesystem-safe, still readable. Anything a path separator or a Windows
/// reserved character could be mistaken for is dropped, not escaped — this
/// name is for a human browsing a folder, and the id keeps uniqueness.
fn slugify(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') {
                c
            } else {
                ' '
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    // A leading dot would hide the file; a trailing dot or space is invalid on
    // Windows and silently stripped on some filesystems.
    let trimmed = collapsed.trim_matches(|c: char| c == '.' || c.is_whitespace());

    let mut out = String::new();
    for c in trimmed.chars() {
        if out.len() + c.len_utf8() > MAX_STEM {
            break;
        }
        out.push(c);
    }
    let out = out.trim_end().to_string();
    if out.is_empty() {
        "Untitled".to_string()
    } else {
        out
    }
}

/// Makes `stem` unique within one directory, so two pages that happen to share
/// a title don't overwrite each other.
fn unique_stem(stem: &str, taken: &mut HashSet<String>) -> String {
    let key = stem.to_lowercase();
    if taken.insert(key) {
        return stem.to_string();
    }
    for n in 2.. {
        let candidate = format!("{stem}-{n}");
        if taken.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
    unreachable!()
}

/// Rewrites every `/api/v1/notes/…/raw` reference in `body` to the relative
/// path of the downloaded copy. `depth` is how many directories below the
/// export root this page's file sits, which is what makes the `../` correct.
fn rewrite_links(body: &str, depth: usize, local: &HashMap<String, String>) -> String {
    let mut out = body.to_string();
    for (url, file) in local {
        let rel = format!("{}{}/{}", "../".repeat(depth), ATTACHMENT_DIR, file);
        out = out.replace(url.as_str(), &rel);
    }
    out
}

/// Fetches the export payload, then writes it. Returns what was written so the
/// UI can say something specific instead of "done".
pub async fn run(base: &str, token: &str, dest: PathBuf) -> Result<ExportSummary, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(format!(
            "{}/api/v1/notes/export",
            base.trim_end_matches('/')
        ))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("Could not reach cac: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("cac returned {}", res.status().as_u16()));
    }
    let envelope: Envelope = res
        .json()
        .await
        .map_err(|e| format!("Unexpected response from cac: {e}"))?;
    let payload = envelope
        .data
        .ok_or_else(|| envelope.error.unwrap_or_else(|| "Empty response".into()))?;

    // Attachments first: the markdown can only be rewritten once the local file
    // names exist, and a page written with a link to a file that then failed to
    // download would be a link to nothing.
    let mut local: HashMap<String, String> = HashMap::new();
    let mut failed = 0usize;
    if !payload.attachments.is_empty() {
        let dir = dest.join(ATTACHMENT_DIR);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not create {ATTACHMENT_DIR}: {e}"))?;
        for att in &payload.attachments {
            // The id keeps this unique without needing a per-directory tally;
            // the original name keeps it recognisable.
            let name = format!("{}-{}", &att.id, slugify(&att.file_name));
            match download(&client, base, token, &att.url, &dir.join(&name)).await {
                Ok(()) => {
                    local.insert(att.url.clone(), name);
                }
                Err(e) => {
                    failed += 1;
                    eprintln!("[cac-export] {} ({}): {e}", att.file_name, att.note_id);
                }
            }
        }
    }

    let mut children: HashMap<Option<String>, Vec<&Note>> = HashMap::new();
    for n in &payload.notes {
        children.entry(n.parent_id.clone()).or_default().push(n);
    }

    let mut pages = 0usize;
    write_level(&dest, None, &children, &local, 0, &mut pages)?;

    Ok(ExportSummary {
        pages,
        attachments: local.len(),
        failed_attachments: failed,
        dir: dest.to_string_lossy().to_string(),
    })
}

/// Writes every page at one level, recursing into the ones that have children.
/// A page with subpages becomes `Name.md` *and* a `Name/` directory beside it —
/// the layout Notion itself exports, so it reads as expected in Obsidian or any
/// file browser.
fn write_level(
    dir: &Path,
    parent: Option<String>,
    children: &HashMap<Option<String>, Vec<&Note>>,
    local: &HashMap<String, String>,
    depth: usize,
    pages: &mut usize,
) -> Result<(), String> {
    let Some(level) = children.get(&parent) else {
        return Ok(());
    };
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {dir:?}: {e}"))?;

    let mut taken: HashSet<String> = HashSet::new();
    for note in level {
        let stem = unique_stem(&slugify(&note.title), &mut taken);

        let title = if note.title.trim().is_empty() {
            "Untitled"
        } else {
            note.title.trim()
        };
        // The title is a column, not part of the body, so without this line it
        // would survive only as a file name — and file names get slugified and
        // truncated. As an H1 it round-trips into any markdown reader intact.
        let contents = format!("# {title}\n\n{}\n", rewrite_links(&note.body, depth, local));
        std::fs::write(dir.join(format!("{stem}.md")), contents)
            .map_err(|e| format!("Could not write {stem}.md: {e}"))?;
        *pages += 1;

        if children.contains_key(&Some(note.id.clone())) {
            write_level(
                &dir.join(&stem),
                Some(note.id.clone()),
                children,
                local,
                depth + 1,
                pages,
            )?;
        }
    }
    Ok(())
}

async fn download(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    path: &str,
    target: &Path,
) -> Result<(), String> {
    let res = client
        .get(format!("{}{}", base.trim_end_matches('/'), path))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("server returned {}", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    std::fs::write(target, &bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_safe_and_readable() {
        assert_eq!(
            slugify("Chapter 3: Kubernetes / etcd"),
            "Chapter 3 Kubernetes etcd"
        );
        assert_eq!(slugify("  "), "Untitled");
        assert_eq!(slugify(""), "Untitled");
        // A leading dot would hide the file on unix.
        assert_eq!(slugify(".hidden"), "hidden");
        // Path separators must never survive into a file name.
        assert!(!slugify("a/b\\c").contains('/'));
        assert!(!slugify("a/b\\c").contains('\\'));
        assert!(slugify(&"x".repeat(500)).len() <= MAX_STEM);
    }

    #[test]
    fn duplicate_titles_do_not_overwrite_each_other() {
        let mut taken = HashSet::new();
        assert_eq!(unique_stem("Notes", &mut taken), "Notes");
        assert_eq!(unique_stem("Notes", &mut taken), "Notes-2");
        assert_eq!(unique_stem("Notes", &mut taken), "Notes-3");
        // Case-insensitive: two files differing only in case collide on macOS
        // and Windows even though they wouldn't on Linux.
        assert_eq!(unique_stem("NOTES", &mut taken), "NOTES-4");
    }

    /// The whole point of the feature: what lands on disk has to be a readable
    /// tree, with the title preserved and the image pointing at the local copy
    /// — checked against a real filesystem rather than a mock, since "does it
    /// actually write the folder" is precisely the thing that could be wrong.
    #[test]
    fn writes_a_nested_readable_tree() {
        let root = std::env::temp_dir().join(format!("cac-export-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let parent = Note {
            id: "n1".into(),
            parent_id: None,
            title: "Kubernetes".into(),
            body: "![shot](/api/v1/notes/n1/attachments/a1/raw)".into(),
        };
        let child = Note {
            id: "n2".into(),
            parent_id: Some("n1".into()),
            title: "etcd: quorum".into(),
            body: "body of the child".into(),
        };
        let untitled = Note {
            id: "n3".into(),
            parent_id: None,
            title: "".into(),
            body: "".into(),
        };

        let mut children: HashMap<Option<String>, Vec<&Note>> = HashMap::new();
        children.insert(None, vec![&parent, &untitled]);
        children.insert(Some("n1".into()), vec![&child]);

        let mut local = HashMap::new();
        local.insert(
            "/api/v1/notes/n1/attachments/a1/raw".to_string(),
            "a1-shot.png".to_string(),
        );

        let mut pages = 0;
        write_level(&root, None, &children, &local, 0, &mut pages).unwrap();
        assert_eq!(pages, 3);

        // A page with subpages is a file *and* a sibling directory — the layout
        // Notion exports, so it opens as expected in Obsidian.
        let top = std::fs::read_to_string(root.join("Kubernetes.md")).unwrap();
        assert!(top.starts_with("# Kubernetes\n"));
        assert!(
            top.contains("(_attachments/a1-shot.png)"),
            "root-level page links straight into _attachments: {top}"
        );

        let nested = std::fs::read_to_string(root.join("Kubernetes/etcd quorum.md")).unwrap();
        assert!(
            nested.starts_with("# etcd: quorum\n"),
            "title kept verbatim, not slugified"
        );

        // An empty title still produces a file rather than silently vanishing.
        assert!(root.join("Untitled.md").exists());

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn links_become_relative_to_the_pages_depth() {
        let mut local = HashMap::new();
        local.insert(
            "/api/v1/notes/n1/attachments/a1/raw".to_string(),
            "a1-shot.png".to_string(),
        );
        let body = "![shot](/api/v1/notes/n1/attachments/a1/raw)";

        assert_eq!(
            rewrite_links(body, 0, &local),
            "![shot](_attachments/a1-shot.png)"
        );
        assert_eq!(
            rewrite_links(body, 2, &local),
            "![shot](../../_attachments/a1-shot.png)"
        );
    }
}

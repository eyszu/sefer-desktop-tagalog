#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

const DB_FILE: &str = "TagAngBiblia.db";

struct Db(Mutex<Connection>);

#[derive(Serialize)]
struct Book {
    id: i64,
    name: String,
    /// Number of chapters in the book.
    chapters: i64,
}

#[derive(Serialize)]
struct Verse {
    book_id: i64,
    book: String,
    chapter: i64,
    verse: i64,
    text: String,
}

#[derive(Serialize)]
struct SearchResults {
    /// Total number of matching verses (may exceed `results.len()`).
    total: i64,
    results: Vec<Verse>,
}

fn row_to_verse(r: &rusqlite::Row) -> rusqlite::Result<Verse> {
    Ok(Verse {
        book_id: r.get(0)?,
        book: r.get(1)?,
        chapter: r.get(2)?,
        verse: r.get(3)?,
        text: r.get(4)?,
    })
}

const VERSE_SELECT: &str = "SELECT v.book_id, b.name, v.chapter, v.verse, v.text \
     FROM TagAngBiblia_verses v JOIN TagAngBiblia_books b ON b.id = v.book_id";

#[tauri::command]
fn get_books(db: State<Db>) -> Result<Vec<Book>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.name, COALESCE(MAX(v.chapter), 0) \
             FROM TagAngBiblia_books b \
             LEFT JOIN TagAngBiblia_verses v ON v.book_id = b.id \
             GROUP BY b.id ORDER BY b.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Book {
                id: r.get(0)?,
                name: r.get(1)?,
                chapters: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Highest verse number in a chapter (0 if the chapter does not exist).
#[tauri::command]
fn get_verse_count(db: State<Db>, book_id: i64, chapter: i64) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT COALESCE(MAX(verse), 0) FROM TagAngBiblia_verses WHERE book_id = ?1 AND chapter = ?2",
        params![book_id, chapter],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_verse(
    db: State<Db>,
    book_id: i64,
    chapter: i64,
    verse: i64,
) -> Result<Option<Verse>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let sql = format!("{VERSE_SELECT} WHERE v.book_id = ?1 AND v.chapter = ?2 AND v.verse = ?3");
    match conn.query_row(&sql, params![book_id, chapter, verse], row_to_verse) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Verse before (`forward = false`) or after (`forward = true`) the given one,
/// crossing chapter and book boundaries. Returns None at either end of the Bible.
#[tauri::command]
fn step_verse(
    db: State<Db>,
    book_id: i64,
    chapter: i64,
    verse: i64,
    forward: bool,
) -> Result<Option<Verse>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let (cmp, order) = if forward { (">", "ASC") } else { ("<", "DESC") };
    let sql = format!(
        "{VERSE_SELECT} WHERE (v.book_id, v.chapter, v.verse) {cmp} (?1, ?2, ?3) \
         ORDER BY v.book_id {order}, v.chapter {order}, v.verse {order} LIMIT 1"
    );
    match conn.query_row(&sql, params![book_id, chapter, verse], row_to_verse) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Every whitespace-separated word must appear in the verse (case-insensitive for ASCII).
#[tauri::command]
fn search_verses(
    db: State<Db>,
    query: String,
    book_id: Option<i64>,
    limit: Option<i64>,
) -> Result<SearchResults, String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| format!("%{}%", escape_like(t)))
        .collect();
    if terms.is_empty() {
        return Ok(SearchResults { total: 0, results: vec![] });
    }
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut cond = String::from("1=1");
    let mut args: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(b) = book_id {
        cond.push_str(" AND v.book_id = ?");
        args.push(b.into());
    }
    for t in &terms {
        cond.push_str(" AND v.text LIKE ? ESCAPE '\\'");
        args.push(t.clone().into());
    }

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM TagAngBiblia_verses v WHERE {cond}"),
            rusqlite::params_from_iter(args.iter()),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let sql = format!(
        "{VERSE_SELECT} WHERE {cond} ORDER BY v.book_id, v.chapter, v.verse LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let results = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), row_to_verse)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(SearchResults { total, results })
}

fn find_db(app: &tauri::App) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("resources").join(DB_FILE));
        candidates.push(dir.join(DB_FILE));
    }
    // Dev fallback: the file inside the source tree.
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join(DB_FILE));
    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| format!("Could not find {DB_FILE}"))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let path = find_db(app)?;
            let conn = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_books,
            get_verse_count,
            get_verse,
            step_verse,
            search_verses
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

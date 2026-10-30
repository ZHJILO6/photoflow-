use crate::engine::archiver::{self, ArchiveReport};
use crate::engine::extractor::{self, ExportOutcome};
use crate::engine::indexer::{self, FileEntry, LibraryIndex, MediaKind};
use crate::engine::parser::{self, QueryToken};
use crate::engine::storage;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;
use tauri::State;

pub struct AppState {
    pub index: Mutex<Option<LibraryIndex>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            index: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanReport {
    pub root: String,
    pub total: usize,
    pub raw_count: usize,
    pub jpeg_count: usize,
    pub other_count: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchedFile {
    pub path: String,
    pub file_name: String,
    pub kind: String,
    pub size: u64,
    pub capture_date: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchPair {
    pub core_num: Option<u32>,
    pub raw: Option<MatchedFile>,
    pub jpeg: Option<MatchedFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchReport {
    pub hits: Vec<MatchPair>,
    pub hit_count: usize,
    pub raw_hits: usize,
    pub jpeg_hits: usize,
    pub failed_tokens: Vec<String>,
    pub elapsed_ms: u64,
}

fn to_matched(entry: &FileEntry) -> MatchedFile {
    MatchedFile {
        path: entry.path.clone(),
        file_name: entry.file_name.clone(),
        kind: match entry.kind {
            MediaKind::Raw => "RAW".to_string(),
            MediaKind::Jpeg => "JPG".to_string(),
            MediaKind::Other => "OTHER".to_string(),
        },
        size: entry.size,
        capture_date: entry.capture_date.clone(),
    }
}

fn describe_token(token: &QueryToken) -> String {
    match token {
        QueryToken::Range(low, high) => format!("{low}-{high}"),
        QueryToken::Core(core) => core.to_string(),
        QueryToken::Stem(stem) => stem.clone(),
    }
}

#[tauri::command]
pub async fn scan_library(
    state: State<'_, AppState>,
    root_dir: String,
) -> Result<ScanReport, String> {
    let root = PathBuf::from(root_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先填写素材根目录".to_string());
    }

    let index = tauri::async_runtime::spawn_blocking(move || indexer::scan(&root))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    let report = ScanReport {
        root: index.root.clone(),
        total: index.stats.total,
        raw_count: index.stats.raw_count,
        jpeg_count: index.stats.jpeg_count,
        other_count: index.stats.other_count,
        duration_ms: index.stats.duration_ms,
    };

    *state
        .index
        .lock()
        .map_err(|_| "索引状态锁已失效".to_string())? = Some(index);

    Ok(report)
}

#[tauri::command]
pub fn match_files(state: State<'_, AppState>, query_text: String) -> Result<MatchReport, String> {
    let guard = state
        .index
        .lock()
        .map_err(|_| "索引状态锁已失效".to_string())?;
    let index = guard
        .as_ref()
        .ok_or_else(|| "请先扫描素材目录".to_string())?;

    let parsed = parser::parse_query(&query_text);
    if parsed.raw_segments == 0 {
        return Err("未解析出任何可匹配的序号或文件名".to_string());
    }

    let started = Instant::now();
    let mut hit_indices: HashSet<usize> = HashSet::new();
    let mut failed_tokens: Vec<String> = Vec::new();

    for group in &parsed.groups {
        let mut group_hit = false;

        for token in group {
            match token {
                QueryToken::Range(low, high) => {
                    for core in *low..=*high {
                        for file_index in indexer::lookup_core(index, core) {
                            hit_indices.insert(file_index);
                            group_hit = true;
                        }
                    }
                }
                QueryToken::Core(core) => {
                    for file_index in indexer::lookup_core(index, *core) {
                        hit_indices.insert(file_index);
                        group_hit = true;
                    }
                }
                QueryToken::Stem(stem) => {
                    for file_index in indexer::lookup_stem(index, stem) {
                        hit_indices.insert(file_index);
                        group_hit = true;
                    }
                }
            }

            if group_hit {
                break;
            }
        }

        if !group_hit {
            if let Some(token) = group.first() {
                failed_tokens.push(describe_token(token));
            }
        }
    }

    // 以核心序号为键配对 RAW / JPG，无核心序号的散图各自独立成组。
    let mut buckets: BTreeMap<Option<u32>, (Option<usize>, Option<usize>)> = BTreeMap::new();

    for file_index in hit_indices {
        let entry = &index.files[file_index];
        let slot = buckets.entry(entry.core_num).or_default();
        match entry.kind {
            MediaKind::Raw => {
                if slot.0.is_none() {
                    slot.0 = Some(file_index);
                }
            }
            MediaKind::Jpeg => {
                if slot.1.is_none() {
                    slot.1 = Some(file_index);
                }
            }
            MediaKind::Other => {}
        }
    }

    let mut hits: Vec<MatchPair> = Vec::with_capacity(buckets.len());
    let mut raw_hits = 0usize;
    let mut jpeg_hits = 0usize;

    for (core_num, (raw_index, jpeg_index)) in buckets {
        let raw = raw_index.map(|value| to_matched(&index.files[value]));
        let jpeg = jpeg_index.map(|value| to_matched(&index.files[value]));
        if raw.is_some() {
            raw_hits += 1;
        }
        if jpeg.is_some() {
            jpeg_hits += 1;
        }
        hits.push(MatchPair {
            core_num,
            raw,
            jpeg,
        });
    }

    Ok(MatchReport {
        hit_count: hits.len(),
        hits,
        raw_hits,
        jpeg_hits,
        failed_tokens,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn quick_export_preview(
    raw_path: String,
    dest_path: String,
    max_edge: u32,
    quality: u8,
    max_bytes: Option<u64>,
) -> Result<ExportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        extractor::export_preview_with_limit(
            Path::new(&raw_path),
            Path::new(&dest_path),
            max_edge,
            quality,
            max_bytes,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn scan_card(card_dir: String) -> Result<ScanReport, String> {
    let root = PathBuf::from(card_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先选择存储卡根目录".to_string());
    }

    let index = tauri::async_runtime::spawn_blocking(move || indexer::scan(&root))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    Ok(ScanReport {
        root: index.root.clone(),
        total: index.stats.total,
        raw_count: index.stats.raw_count,
        jpeg_count: index.stats.jpeg_count,
        other_count: index.stats.other_count,
        duration_ms: index.stats.duration_ms,
    })
}

/// 导入预演：只扫描与判重，不写任何文件，用于导入前确认目标目录是否正确。
#[tauri::command]
pub async fn import_card_preview(
    card_dir: String,
    dest_dir: String,
) -> Result<ArchiveReport, String> {
    let root = PathBuf::from(card_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先选择存储卡根目录".to_string());
    }
    let dest = PathBuf::from(dest_dir.trim());
    if dest.as_os_str().is_empty() {
        return Err("请先选择归档根目录".to_string());
    }
    if root == dest {
        return Err("归档目录不能与存储卡目录相同，否则会重复拷贝自身文件".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let index = indexer::scan(&root)?;
        archiver::plan_entries(index.files, &dest)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn import_card(card_dir: String, dest_dir: String) -> Result<ArchiveReport, String> {
    let root = PathBuf::from(card_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先选择存储卡根目录".to_string());
    }
    let dest = PathBuf::from(dest_dir.trim());
    if dest.as_os_str().is_empty() {
        return Err("请先选择归档根目录".to_string());
    }
    if root == dest {
        return Err("归档目录不能与存储卡目录相同，否则会重复拷贝自身文件".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let index = indexer::scan(&root)?;
        archiver::archive_entries(index.files, &dest)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn copy_matched(
    paths: Vec<String>,
    dest_dir: String,
) -> Result<ArchiveReport, String> {
    if paths.is_empty() {
        return Err("没有可复制的匹配项".to_string());
    }

    let dest = PathBuf::from(dest_dir.trim());
    if dest.as_os_str().is_empty() {
        return Err("请填写归档目标目录".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let entries: Vec<FileEntry> = paths
            .iter()
            .filter_map(|path| indexer::build_entry(Path::new(path)).ok())
            .collect();
        archiver::archive_entries(entries, &dest)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

/// 匹配清单导出到 CSV 的一行。
#[derive(Debug, Deserialize)]
pub struct MatchCsvRow {
    pub core_num: Option<u32>,
    pub raw_name: Option<String>,
    pub raw_path: Option<String>,
    pub raw_size: Option<u64>,
    pub jpeg_name: Option<String>,
    pub jpeg_path: Option<String>,
    pub jpeg_size: Option<u64>,
}

fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn mb(value: Option<u64>) -> String {
    match value {
        Some(bytes) => format!("{:.2}", bytes as f64 / (1024.0 * 1024.0)),
        None => String::new(),
    }
}

/// 将当前匹配结果写成 CSV（UTF-8 BOM + CRLF，Excel 可直接双击打开）。
#[tauri::command]
pub fn write_match_csv(dest_path: String, rows: Vec<MatchCsvRow>) -> Result<usize, String> {
    let dest = PathBuf::from(dest_path.trim());
    if dest.as_os_str().is_empty() {
        return Err("请选择 CSV 保存位置".to_string());
    }
    if rows.is_empty() {
        return Err("当前没有可导出的匹配结果".to_string());
    }

    let mut content = String::from("\u{FEFF}序号,状态,RAW文件名,RAW路径,RAW体积(MB),JPG文件名,JPG路径,JPG体积(MB)\r\n");

    for row in &rows {
        let status = match (row.raw_name.is_some(), row.jpeg_name.is_some()) {
            (true, true) => "PAIRED",
            (true, false) => "RAW_ONLY",
            (false, true) => "JPG_ONLY",
            (false, false) => "EMPTY",
        };
        let core = row
            .core_num
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".to_string());

        content.push_str(&format!(
            "{},{},{},{},{},{},{},{}\r\n",
            core,
            status,
            csv_field(row.raw_name.as_deref().unwrap_or("")),
            csv_field(row.raw_path.as_deref().unwrap_or("")),
            mb(row.raw_size),
            csv_field(row.jpeg_name.as_deref().unwrap_or("")),
            csv_field(row.jpeg_path.as_deref().unwrap_or("")),
            mb(row.jpeg_size),
        ));
    }

    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }
    std::fs::write(&dest, content).map_err(|error| error.to_string())?;

    Ok(rows.len())
}

/// 挑片列表项：仅 JPEG，带精确到秒的拍摄时间，供连拍分组使用。
#[derive(Debug, Clone, Serialize)]
pub struct CullItem {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    pub capture_date: String,
    pub epoch: i64,
    pub rating: Option<u8>,
}

/// 列出目录下的 JPG（含 HEIC/HEIF），按拍摄时间升序，用于挑片与连拍分组。
#[derive(Debug, Clone, Serialize)]
pub struct CullScanReport {
    pub items: Vec<CullItem>,
    pub total_files: usize,
    pub skipped: usize,
}

#[tauri::command]
pub async fn cull_list(root_dir: String) -> Result<CullScanReport, String> {
    let root = PathBuf::from(root_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先选择拍摄目录".to_string());
    }
    if !root.exists() {
        return Err("目录不存在".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let index = indexer::scan(&root).map_err(|error| error.to_string())?;
        let total_files = index.files.len();
        let mut items: Vec<CullItem> = index
            .files
            .iter()
            .filter(|file| {
                matches!(file.kind, MediaKind::Jpeg)
                    && matches!(file.ext.as_str(), "jpg" | "jpeg" | "jpe" | "heic" | "heif")
            })
            .map(|file| CullItem {
                path: file.path.clone(),
                file_name: file.file_name.clone(),
                size: file.size,
                capture_date: file.capture_date.clone(),
                epoch: file.capture_epoch,
                rating: crate::engine::rating::read_rating(Path::new(&file.path)),
            })
            .collect();
        items.sort_by(|left, right| {
            left.epoch
                .cmp(&right.epoch)
                .then_with(|| left.file_name.cmp(&right.file_name))
        });
        let skipped = total_files.saturating_sub(items.len());
        Ok::<CullScanReport, String>(CullScanReport {
            items,
            total_files,
            skipped,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Clone, Deserialize)]
pub struct CullCsvRow {
    pub file_name: String,
    pub path: String,
    pub capture_date: String,
    pub mark: String,
    pub size: u64,
}

/// 导出挑片清单（含保留/淘汰标记），UTF-8 BOM + CRLF。
#[tauri::command]
pub fn write_cull_csv(dest_path: String, rows: Vec<CullCsvRow>) -> Result<usize, String> {
    let dest = PathBuf::from(dest_path.trim());
    if dest.as_os_str().is_empty() {
        return Err("请选择 CSV 保存位置".to_string());
    }
    if rows.is_empty() {
        return Err("当前没有可导出的文件".to_string());
    }

    let mut content = String::from("\u{FEFF}文件名,拍摄日期,标记,体积(MB),路径\r\n");
    for row in &rows {
        content.push_str(&format!(
            "{},{},{},{},{}\r\n",
            csv_field(&row.file_name),
            csv_field(&row.capture_date),
            csv_field(&row.mark),
            mb(Some(row.size)),
            csv_field(&row.path),
        ));
    }

    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }
    std::fs::write(&dest, content).map_err(|error| error.to_string())?;
    Ok(rows.len())
}

#[derive(Debug, Clone, Deserialize)]
pub struct CullRatingRow {
    pub path: String,
    pub rating: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct RatingReport {
    pub written: usize,
    pub cleared: usize,
    pub failed: Vec<String>,
    pub duration_ms: u64,
}

/// 把挑片结果写回文件（保留=3 星，淘汰=0 星），直接改写 JPEG 的 XMP 段。
#[tauri::command]
pub async fn apply_cull_ratings(rows: Vec<CullRatingRow>) -> Result<RatingReport, String> {
    if rows.is_empty() {
        return Err("没有需要写回的星标".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let mut written = 0usize;
        let mut cleared = 0usize;
        let mut failed: Vec<String> = Vec::new();

        for row in rows {
            match crate::engine::rating::write_rating(Path::new(&row.path), row.rating) {
                Ok(()) => {
                    written += 1;
                    if row.rating == 0 {
                        cleared += 1;
                    }
                }
                Err(error) => failed.push(format!("{}：{error}", row.path)),
            }
        }

        Ok::<RatingReport, String>(RatingReport {
            written,
            cleared,
            failed,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 把保留项原片按原样复制到交付目录：不重新编码，流式拷贝并回读哈希校验。
#[tauri::command]
pub async fn copy_cull_kept(
    paths: Vec<String>,
    dest_dir: String,
) -> Result<archiver::ArchiveReport, String> {
    let root = PathBuf::from(dest_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先选择交付目录".to_string());
    }
    if paths.is_empty() {
        return Err("还没有标记为保留的照片".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;

        let mut report = archiver::ArchiveReport::default();
        for value in paths {
            let source = Path::new(&value);
            let Some(name) = source.file_name().and_then(|item| item.to_str()) else {
                report.failed.push(format!("{value}：文件名无法解析"));
                continue;
            };

            let mut dest = root.join(name);
            if dest.exists() {
                let same_size = std::fs::metadata(&dest).map(|item| item.len()).ok()
                    == std::fs::metadata(source).map(|item| item.len()).ok();
                let same_hash = same_size
                    && archiver::hash_file_xxh64(&dest).ok()
                        == archiver::hash_file_xxh64(source).ok();
                if same_hash {
                    report.skipped_existing += 1;
                    continue;
                }

                let stem = Path::new(name)
                    .file_stem()
                    .and_then(|item| item.to_str())
                    .unwrap_or("photo");
                let ext = Path::new(name)
                    .extension()
                    .and_then(|item| item.to_str())
                    .unwrap_or("jpg");
                let mut index = 1u32;
                let mut candidate = root.join(format!("{stem}_{index}.{ext}"));
                while candidate.exists() && index < 999 {
                    index += 1;
                    candidate = root.join(format!("{stem}_{index}.{ext}"));
                }
                dest = candidate;
            }

            match archiver::copy_streaming_verified(source, &dest) {
                Ok(_) => {
                    report.copied += 1;
                    report.destinations.push(dest.to_string_lossy().to_string());
                }
                Err(error) => report.failed.push(format!("{name}：{error}")),
            }
        }

        report.duration_ms = started.elapsed().as_millis() as u64;
        Ok::<archiver::ArchiveReport, String>(report)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 原分辨率预览 data URL，供挑片页 100% 检查焦点（最长边到 8000px，不缩放）。
#[tauri::command]
pub async fn focus_preview_data_url(
    path: String,
    rotation: Option<u32>,
) -> Result<String, String> {
    let quarter = rotation.unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || {
        extractor::preview_data_url(Path::new(&path), 8000, 90, quarter)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn thumbnail_data_url(
    path: String,
    max_edge: u32,
    rotation: Option<u32>,
) -> Result<String, String> {
    let quarter = rotation.unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || {
        extractor::thumbnail_data_url_rotated(Path::new(&path), max_edge, quarter)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 列出可导出预览的素材（RAW + HEIC/HEIF），供「批量导出」独立页使用。
#[tauri::command]
pub async fn scan_export_sources(root_dir: String) -> Result<Vec<MatchedFile>, String> {
    let root = PathBuf::from(root_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先选择素材目录".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let index = indexer::scan(&root).map_err(|error| error.to_string())?;
        let files: Vec<MatchedFile> = index
            .files
            .iter()
            .filter(|file| {
                file.kind == MediaKind::Raw
                    || (file.kind == MediaKind::Jpeg
                        && matches!(file.ext.as_str(), "heic" | "heif"))
            })
            .map(to_matched)
            .collect();
        Ok::<Vec<MatchedFile>, String>(files)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveBucket {
    pub date: String,
    pub raw: usize,
    pub jpeg: usize,
    pub other: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveStats {
    pub root: String,
    pub buckets: Vec<ArchiveBucket>,
    pub total_files: usize,
    pub raw_count: usize,
    pub jpeg_count: usize,
    pub total_bytes: u64,
    pub duration_ms: u64,
}

fn accumulate_bucket(dir: &Path, bucket: &mut ArchiveBucket, total_files: &mut usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|item| item.ok()) {
        let path = entry.path();
        if path.is_dir() {
            accumulate_bucket(&path, bucket, total_files);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match indexer::classify(&ext) {
            MediaKind::Raw => bucket.raw += 1,
            MediaKind::Jpeg => bucket.jpeg += 1,
            MediaKind::Other => bucket.other += 1,
        }
        if let Ok(metadata) = path.metadata() {
            bucket.bytes += metadata.len();
        }
        *total_files += 1;
    }
}

/// 扫描归档库，按日期桶统计 RAW / JPG / 体积，供「归档」面板展示。
#[tauri::command]
pub async fn scan_archive(root_dir: String) -> Result<ArchiveStats, String> {
    let root = PathBuf::from(root_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先选择归档目录".to_string());
    }
    if !root.exists() {
        return Err("归档目录不存在".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let mut buckets: Vec<ArchiveBucket> = Vec::new();
        let mut total_files = 0usize;
        let mut raw_count = 0usize;
        let mut jpeg_count = 0usize;
        let mut total_bytes = 0u64;

        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.filter_map(|item| item.ok()) {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let mut bucket = ArchiveBucket {
                    date: entry.file_name().to_string_lossy().to_string(),
                    raw: 0,
                    jpeg: 0,
                    other: 0,
                    bytes: 0,
                };
                accumulate_bucket(&path, &mut bucket, &mut total_files);
                raw_count += bucket.raw;
                jpeg_count += bucket.jpeg;
                total_bytes += bucket.bytes;
                buckets.push(bucket);
            }
        }

        buckets.sort_by(|left, right| right.date.cmp(&left.date));

        Ok::<ArchiveStats, String>(ArchiveStats {
            root: root.to_string_lossy().to_string(),
            buckets,
            total_files,
            raw_count,
            jpeg_count,
            total_bytes,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 在系统文件管理器中打开归档目录。
#[tauri::command]
pub fn open_archive_dir(path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if !target.exists() {
        return Err("目录不存在".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&target)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 在归档库内按序号 / 文件名检索原片；查询为空时返回全部归档文件。
#[tauri::command]
pub async fn search_archive(root_dir: String, query_text: String) -> Result<Vec<MatchedFile>, String> {
    let root = PathBuf::from(root_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先选择归档目录".to_string());
    }
    if !root.exists() {
        return Err("归档目录不存在".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let index = indexer::scan(&root).map_err(|error| error.to_string())?;

        let mut hits: Vec<usize> = if query_text.trim().is_empty() {
            (0..index.files.len()).collect()
        } else {
            let parsed = parser::parse_query(&query_text);
            if parsed.raw_segments == 0 {
                return Err("未解析出任何可匹配的序号或文件名".to_string());
            }
            let mut hit_set: HashSet<usize> = HashSet::new();
            for group in &parsed.groups {
                let mut group_hit = false;
                for token in group {
                    match token {
                        QueryToken::Range(low, high) => {
                            for core in *low..=*high {
                                for file_index in indexer::lookup_core(&index, core) {
                                    hit_set.insert(file_index);
                                    group_hit = true;
                                }
                            }
                        }
                        QueryToken::Core(core) => {
                            for file_index in indexer::lookup_core(&index, *core) {
                                hit_set.insert(file_index);
                                group_hit = true;
                            }
                        }
                        QueryToken::Stem(stem) => {
                            for file_index in indexer::lookup_stem(&index, stem) {
                                hit_set.insert(file_index);
                                group_hit = true;
                            }
                        }
                    }
                    if group_hit {
                        break;
                    }
                }
            }
            hit_set.into_iter().collect()
        };

        hits.sort_by(|left, right| {
            let a = &index.files[*left];
            let b = &index.files[*right];
            b.capture_date
                .cmp(&a.capture_date)
                .then_with(|| a.file_name.cmp(&b.file_name))
        });

        Ok::<Vec<MatchedFile>, String>(hits.iter().map(|i| to_matched(&index.files[*i])).collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn collect_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(|item| item.ok()) {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else if path.is_file() {
            out.push(path);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DuplicateGroup {
    pub size: u64,
    pub hash: String,
    pub files: Vec<String>,
}

/// 查找归档库中内容完全相同的文件（体积分桶 + xxHash64）。
#[tauri::command]
pub async fn find_archive_duplicates(root_dir: String) -> Result<Vec<DuplicateGroup>, String> {
    let root = PathBuf::from(root_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先选择归档目录".to_string());
    }
    if !root.exists() {
        return Err("归档目录不存在".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut files: Vec<PathBuf> = Vec::new();
        collect_files(&root, &mut files);

        let mut by_size: BTreeMap<u64, Vec<PathBuf>> = BTreeMap::new();
        for path in files {
            if let Ok(metadata) = path.metadata() {
                by_size.entry(metadata.len()).or_default().push(path);
            }
        }

        let mut groups: Vec<DuplicateGroup> = Vec::new();
        for (size, paths) in by_size {
            if paths.len() < 2 {
                continue;
            }
            let mut by_hash: BTreeMap<u64, Vec<PathBuf>> = BTreeMap::new();
            for path in paths {
                if let Ok(hash) = archiver::hash_file_xxh64(&path) {
                    by_hash.entry(hash).or_default().push(path);
                }
            }
            for (hash, mut paths) in by_hash {
                if paths.len() < 2 {
                    continue;
                }
                paths.sort();
                groups.push(DuplicateGroup {
                    size,
                    hash: format!("{hash:016x}"),
                    files: paths
                        .iter()
                        .map(|path| path.to_string_lossy().to_string())
                        .collect(),
                });
            }
        }

        groups.sort_by(|left, right| right.size.cmp(&left.size));
        Ok::<Vec<DuplicateGroup>, String>(groups)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Clone, Serialize)]
pub struct CleanupReport {
    pub removed_files: usize,
    pub removed_dirs: usize,
    pub freed_bytes: u64,
    pub failed: Vec<String>,
    pub duration_ms: u64,
}

/// 删除归档库中的重复副本：每组保留路径排序第一个，其余删除。调用前需用户确认。
#[tauri::command]
pub async fn cleanup_archive_duplicates(root_dir: String) -> Result<CleanupReport, String> {
    let root = PathBuf::from(root_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先选择归档目录".to_string());
    }
    if !root.exists() {
        return Err("归档目录不存在".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let mut removed_files = 0usize;
        let mut freed_bytes = 0u64;
        let mut failed: Vec<String> = Vec::new();

        let mut files: Vec<PathBuf> = Vec::new();
        collect_files(&root, &mut files);

        let mut by_size: BTreeMap<u64, Vec<PathBuf>> = BTreeMap::new();
        for path in files {
            if let Ok(metadata) = path.metadata() {
                by_size.entry(metadata.len()).or_default().push(path);
            }
        }

        for (size, paths) in by_size {
            if paths.len() < 2 {
                continue;
            }
            let mut by_hash: BTreeMap<u64, Vec<PathBuf>> = BTreeMap::new();
            for path in paths {
                match archiver::hash_file_xxh64(&path) {
                    Ok(hash) => by_hash.entry(hash).or_default().push(path),
                    Err(error) => failed.push(format!("{}：{error}", path.display())),
                }
            }
            for (_, mut paths) in by_hash {
                if paths.len() < 2 {
                    continue;
                }
                paths.sort();
                for path in paths.into_iter().skip(1) {
                    match std::fs::remove_file(&path) {
                        Ok(()) => {
                            removed_files += 1;
                            freed_bytes += size;
                        }
                        Err(error) => failed.push(format!("{}：{error}", path.display())),
                    }
                }
            }
        }

        let removed_dirs = prune_empty_dirs(&root, true);

        Ok::<CleanupReport, String>(CleanupReport {
            removed_files,
            removed_dirs,
            freed_bytes,
            failed,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn prune_empty_dirs(dir: &Path, is_root: bool) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.filter_map(|item| item.ok()) {
        let path = entry.path();
        if path.is_dir() {
            removed += prune_empty_dirs(&path, false);
        }
    }
    if !is_root && std::fs::read_dir(dir).map(|mut it| it.next().is_none()).unwrap_or(false) {
        if std::fs::remove_dir(dir).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// 仅清理归档库中的空目录（不动任何文件）。
#[tauri::command]
pub async fn cleanup_empty_dirs(root_dir: String) -> Result<CleanupReport, String> {
    let root = PathBuf::from(root_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("请先选择归档目录".to_string());
    }
    if !root.exists() {
        return Err("归档目录不存在".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let removed_dirs = prune_empty_dirs(&root, true);
        Ok::<CleanupReport, String>(CleanupReport {
            removed_files: 0,
            removed_dirs,
            freed_bytes: 0,
            failed: Vec::new(),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Clone, Serialize)]
pub struct CardDetectedPayload {
    pub root: String,
}

/// 列出所有存储设备（含内置盘），统一结构 `{ name, path, is_removable }`。
#[tauri::command]
pub fn storage_devices() -> Vec<storage::StorageDevice> {
    storage::list_storage_devices()
}

/// 后台轮询可移动设备，插入新卡时向前端推送 `card-detected` 事件。
pub fn start_card_watch(app: tauri::AppHandle) {
    use tauri::Emitter;

    std::thread::spawn(move || {
        let mut known: HashSet<String> = storage::removable_devices()
            .into_iter()
            .map(|device| device.path)
            .collect();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let current = storage::removable_devices();
            for device in &current {
                if !known.contains(&device.path) {
                    let _ = app.emit(
                        "card-detected",
                        CardDetectedPayload {
                            root: device.path.clone(),
                        },
                    );
                }
            }
            known = current.into_iter().map(|device| device.path).collect();
        }
    });
}

use crate::engine::parser::core_number;
use crate::engine::EngineError;
use chrono::{DateTime, Local};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};
use walkdir::WalkDir;

const RAW_EXTENSIONS: &[&str] = &[
    "cr2", "cr3", "arw", "nef", "raf", "dng", "orf", "rw2", "pef", "srw", "3fr", "erf", "mrw",
    "x3f", "iiq", "k25", "kdc", "dcr", "srf",
];

const JPEG_EXTENSIONS: &[&str] = &["jpg", "jpeg", "jpe", "heic", "heif"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Raw,
    Jpeg,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub file_name: String,
    pub stem: String,
    pub ext: String,
    pub kind: MediaKind,
    pub size: u64,
    pub capture_date: String,
    pub capture_epoch: i64,
    pub core_num: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScanStats {
    pub total: usize,
    pub raw_count: usize,
    pub jpeg_count: usize,
    pub other_count: usize,
    pub duration_ms: u64,
}

/// 双向内存索引：文件名基准 + 序号核心基准。
pub struct LibraryIndex {
    pub root: String,
    pub files: Vec<FileEntry>,
    pub by_stem: HashMap<String, Vec<usize>>,
    pub by_core: HashMap<u32, Vec<usize>>,
    pub stats: ScanStats,
}

pub fn is_supported_extension(ext: &str) -> bool {
    let lower = ext.to_ascii_lowercase();
    RAW_EXTENSIONS.contains(&lower.as_str()) || JPEG_EXTENSIONS.contains(&lower.as_str())
}

pub fn classify(ext: &str) -> MediaKind {
    let lower = ext.to_ascii_lowercase();
    if RAW_EXTENSIONS.contains(&lower.as_str()) {
        MediaKind::Raw
    } else if JPEG_EXTENSIONS.contains(&lower.as_str()) {
        MediaKind::Jpeg
    } else {
        MediaKind::Other
    }
}

fn capture_date(modified: Option<SystemTime>) -> String {
    modified
        .and_then(|time| {
            let dt: DateTime<Local> = time.into();
            Some(dt.format("%Y%m%d").to_string())
        })
        .unwrap_or_else(|| "00000000".to_string())
}

/// 构建单个文件条目。供索引器与归档命令复用。
pub(crate) fn build_entry(path: &Path) -> Result<FileEntry, EngineError> {
    let metadata = path.metadata()?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let kind = classify(&ext);
    // 优先 EXIF 拍摄日期，读不到（CR3/HEIC 等容器或无效字段）时回退文件修改时间。
    let capture_date = crate::engine::exif::capture_date(path)
        .unwrap_or_else(|| capture_date(metadata.modified().ok()));
    let capture_epoch = crate::engine::exif::capture_timestamp(path)
        .or_else(|| {
            metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs() as i64)
        })
        .unwrap_or_default();

    Ok(FileEntry {
        path: path.to_string_lossy().to_string(),
        file_name,
        stem: stem.to_lowercase(),
        kind,
        size: metadata.len(),
        capture_date,
        capture_epoch,
        core_num: core_number(&stem),
        ext,
    })
}

/// walkdir 遍历 + rayon 并行 stat/解析，建立双向索引。
pub fn scan(root: &Path) -> Result<LibraryIndex, EngineError> {
    if !root.exists() {
        return Err(EngineError::InvalidPath(format!(
            "目录不存在: {}",
            root.display()
        )));
    }
    if !root.is_dir() {
        return Err(EngineError::InvalidPath(format!(
            "不是目录: {}",
            root.display()
        )));
    }

    let started = Instant::now();

    let candidates: Vec<PathBuf> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(is_supported_extension)
                .unwrap_or(false)
        })
        .collect();

    let files: Vec<FileEntry> = candidates
        .par_iter()
        .filter_map(|path| build_entry(path).ok())
        .collect();

    let mut by_stem: HashMap<String, Vec<usize>> = HashMap::with_capacity(files.len());
    let mut by_core: HashMap<u32, Vec<usize>> = HashMap::with_capacity(files.len());

    for (index, entry) in files.iter().enumerate() {
        by_stem
            .entry(entry.stem.clone())
            .or_default()
            .push(index);
        if let Some(core) = entry.core_num {
            by_core.entry(core).or_default().push(index);
        }
    }

    let raw_count = files
        .iter()
        .filter(|entry| entry.kind == MediaKind::Raw)
        .count();
    let jpeg_count = files
        .iter()
        .filter(|entry| entry.kind == MediaKind::Jpeg)
        .count();

    let stats = ScanStats {
        total: files.len(),
        raw_count,
        jpeg_count,
        other_count: files.len() - raw_count - jpeg_count,
        duration_ms: started.elapsed().as_millis() as u64,
    };

    Ok(LibraryIndex {
        root: root.to_string_lossy().to_string(),
        files,
        by_stem,
        by_core,
        stats,
    })
}

/// 按序号在索引中查找文件下标。
pub fn lookup_core(index: &LibraryIndex, core: u32) -> Vec<usize> {
    index.by_core.get(&core).cloned().unwrap_or_default()
}

/// 按文件名基准查找文件下标。
pub fn lookup_stem(index: &LibraryIndex, stem: &str) -> Vec<usize> {
    index
        .by_stem
        .get(&stem.to_lowercase())
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_whitelist() {
        assert!(is_supported_extension("CR2"));
        assert!(is_supported_extension("jpg"));
        assert!(is_supported_extension("HEIC"));
        assert!(!is_supported_extension("txt"));
    }

    #[test]
    fn classify_kinds() {
        assert_eq!(classify("NEF"), MediaKind::Raw);
        assert_eq!(classify("JPG"), MediaKind::Jpeg);
        assert_eq!(classify("mp4"), MediaKind::Other);
    }

    #[test]
    fn scan_orders_jpegs_by_modified_time() {
        use std::time::{Duration, SystemTime};

        let base = std::env::temp_dir().join(format!("photoflow_scan_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        let now = SystemTime::now();
        for (name, seconds_ago) in [("a.jpg", 30u64), ("b.jpg", 32), ("c.jpg", 50)] {
            let path = base.join(name);
            std::fs::write(&path, b"not-a-real-jpeg").unwrap();
            let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.set_modified(now - Duration::from_secs(seconds_ago))
                .unwrap();
        }
        std::fs::write(base.join("raw_only.CR2"), b"x").unwrap();

        let index = scan(&base).unwrap();
        let mut jpegs: Vec<&FileEntry> = index
            .files
            .iter()
            .filter(|file| file.kind == MediaKind::Jpeg)
            .collect();
        jpegs.sort_by(|left, right| left.capture_epoch.cmp(&right.capture_epoch));

        assert_eq!(jpegs.len(), 3, "RAW 不应进入 JPG 挑片列表");
        assert_eq!(jpegs[0].file_name, "c.jpg");
        assert_eq!(jpegs[1].file_name, "b.jpg");
        assert_eq!(jpegs[2].file_name, "a.jpg");
        let close_gap = jpegs[2].capture_epoch - jpegs[1].capture_epoch;
        assert!((2..=3).contains(&close_gap), "相邻两张间隔应为 2 秒");
        assert!(
            jpegs[1].capture_epoch - jpegs[0].capture_epoch >= 17,
            "跨组间隔应大于 17 秒"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}

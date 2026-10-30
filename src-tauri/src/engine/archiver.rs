use crate::engine::indexer::{is_supported_extension, FileEntry, MediaKind};
use crate::engine::EngineError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::Hasher;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use twox_hash::XxHash64;
use walkdir::WalkDir;

/// 哈希读取缓冲：1MB。
const HASH_BUFFER: usize = 1024 * 1024;
/// 流式拷贝缓冲：2MB。
const COPY_BUFFER: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopyReport {
    pub dest_path: String,
    pub bytes: u64,
    pub hash: u64,
    pub verified: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ArchiveReport {
    pub copied: usize,
    pub skipped_duplicates: usize,
    pub skipped_existing: usize,
    pub failed: Vec<String>,
    pub destinations: Vec<String>,
    pub duration_ms: u64,
}

/// 基于 xxHash64 的 1MB 缓冲高速文件哈希。
pub fn hash_file_xxh64(path: &Path) -> Result<u64, EngineError> {
    let mut file = File::open(path)?;
    let mut buffer = vec![0u8; HASH_BUFFER];
    let mut hasher = XxHash64::with_seed(0);

    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.write(&buffer[..read]);
    }

    Ok(hasher.finish())
}

/// 2MB 缓冲的双向流式拷贝，复制完成后重新哈希目标文件校验坏块。
pub fn copy_streaming_verified(src: &Path, dest: &Path) -> Result<CopyReport, EngineError> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut reader = File::open(src)?;
    let mut buffer = vec![0u8; COPY_BUFFER];
    let mut hasher = XxHash64::with_seed(0);
    let mut total: u64 = 0;

    {
        let mut writer = BufWriter::with_capacity(COPY_BUFFER, File::create(dest)?);
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.write(&buffer[..read]);
            writer.write_all(&buffer[..read])?;
            total += read as u64;
        }
        writer.flush()?;
    }

    let source_hash = hasher.finish();
    let dest_hash = hash_file_xxh64(dest)?;

    if dest_hash != source_hash {
        let _ = fs::remove_file(dest);
        return Err(EngineError::HashMismatch(dest.display().to_string()));
    }

    Ok(CopyReport {
        dest_path: dest.to_string_lossy().to_string(),
        bytes: total,
        hash: dest_hash,
        verified: true,
    })
}

/// 按 {拍摄日期_YYYYMMDD}/{RAW|JPG|OTHER}/{原文件名} 解析归档路径。
pub fn destination_for(dest_root: &Path, entry: &FileEntry) -> PathBuf {
    let bucket = match entry.kind {
        MediaKind::Raw => "RAW",
        MediaKind::Jpeg => "JPG",
        MediaKind::Other => "OTHER",
    };
    dest_root
        .join(&entry.capture_date)
        .join(bucket)
        .join(&entry.file_name)
}

fn resolve_collision(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }

    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();

    for index in 1..1000u32 {
        let name = if ext.is_empty() {
            format!("{stem}_{index}")
        } else {
            format!("{stem}_{index}.{ext}")
        };
        let candidate = path.with_file_name(name);
        if !candidate.exists() {
            return candidate;
        }
    }

    path
}

/// 归档库按体积建桶，只对同体积的候选文件做哈希，避免全库重复哈希。
type ArchiveSizeIndex = HashMap<u64, Vec<PathBuf>>;

/// 扫描归档根目录，仅读取 metadata 建立 体积 -> 路径 的索引。
fn index_archive_sizes(root: &Path) -> ArchiveSizeIndex {
    let mut index: ArchiveSizeIndex = HashMap::new();
    if !root.exists() {
        return index;
    }

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|item| item.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let supported = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(is_supported_extension)
            .unwrap_or(false);
        if !supported {
            continue;
        }
        if let Ok(metadata) = entry.metadata() {
            index.entry(metadata.len()).or_default().push(path.to_path_buf());
        }
    }

    index
}

/// 判断归档库中是否已存在同体积 + 同哈希的文件（按需哈希并缓存结果）。
fn archive_contains(
    index: &ArchiveSizeIndex,
    cache: &mut HashMap<PathBuf, u64>,
    size: u64,
    hash: u64,
) -> bool {
    let Some(candidates) = index.get(&size) else {
        return false;
    };

    for path in candidates {
        let candidate_hash = match cache.get(path) {
            Some(value) => *value,
            None => {
                let value = hash_file_xxh64(path).unwrap_or(u64::MAX);
                cache.insert(path.clone(), value);
                value
            }
        };
        if candidate_hash == hash {
            return true;
        }
    }

    false
}

/// 批量归档：源哈希去重 -> 归档库全局查重 -> 流式拷贝并校验。
///
/// 全局查重基于「体积 + xxHash64」，因此同一张卡重复导入、或先按匹配结果复制再整卡导入，
/// 都不会在归档目录里产生第二份相同内容（即使它们落在不同的日期日期桶中）。
pub fn archive_entries<I>(entries: I, dest_root: &Path) -> Result<ArchiveReport, EngineError>
where
    I: IntoIterator<Item = FileEntry>,
{
    let started = Instant::now();
    let mut report = ArchiveReport::default();
    let mut seen_hashes: HashSet<u64> = HashSet::new();
    let mut size_index = index_archive_sizes(dest_root);
    let mut hash_cache: HashMap<PathBuf, u64> = HashMap::new();

    for entry in entries {
        let source = Path::new(&entry.path);

        let source_hash = match hash_file_xxh64(source) {
            Ok(hash) => hash,
            Err(error) => {
                report.failed.push(format!("{}: {}", entry.file_name, error));
                continue;
            }
        };

        if !seen_hashes.insert(source_hash) {
            report.skipped_duplicates += 1;
            continue;
        }

        if archive_contains(&size_index, &mut hash_cache, entry.size, source_hash) {
            report.skipped_existing += 1;
            continue;
        }

        let dest = destination_for(dest_root, &entry);
        let dest = if dest.exists() {
            resolve_collision(dest)
        } else {
            dest
        };

        match copy_streaming_verified(source, &dest) {
            Ok(copy) => {
                size_index
                    .entry(copy.bytes)
                    .or_default()
                    .push(PathBuf::from(&copy.dest_path));
                hash_cache.insert(PathBuf::from(&copy.dest_path), copy.hash);
                report.copied += 1;
                report.destinations.push(copy.dest_path);
            }
            Err(error) => {
                report.failed.push(format!("{}: {}", entry.file_name, error));
            }
        }
    }

    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

/// 导入前预演：只计算不落盘，返回「将新增 / 已存在跳过 / 批内重复 / 失败」的数量。
///
/// 与 [`archive_entries`] 使用完全相同的判重规则，因此预演结果就是真实导入结果的预演。
pub fn plan_entries<I>(entries: I, dest_root: &Path) -> Result<ArchiveReport, EngineError>
where
    I: IntoIterator<Item = FileEntry>,
{
    let started = Instant::now();
    let mut report = ArchiveReport::default();
    let mut seen_hashes: HashSet<u64> = HashSet::new();
    let size_index = index_archive_sizes(dest_root);
    let mut hash_cache: HashMap<PathBuf, u64> = HashMap::new();

    for entry in entries {
        let source = Path::new(&entry.path);

        let source_hash = match hash_file_xxh64(source) {
            Ok(hash) => hash,
            Err(error) => {
                report.failed.push(format!("{}: {}", entry.file_name, error));
                continue;
            }
        };

        if !seen_hashes.insert(source_hash) {
            report.skipped_duplicates += 1;
            continue;
        }

        if archive_contains(&size_index, &mut hash_cache, entry.size, source_hash) {
            report.skipped_existing += 1;
            continue;
        }

        report.copied += 1;
        report
            .destinations
            .push(destination_for(dest_root, &entry).to_string_lossy().to_string());
    }

    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_across_buffers() {
        let temp = std::env::temp_dir().join("photoflow_hash_test.bin");
        let mut payload = vec![0u8; 3 * 1024 * 1024];
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        fs::write(&temp, &payload).unwrap();
        let hash = hash_file_xxh64(&temp).unwrap();
        let _ = fs::remove_file(&temp);
        assert_ne!(hash, 0);
    }

    #[test]
    fn plan_counts_without_touching_disk() {
        let base = std::env::temp_dir().join("photoflow_plan_test");
        let _ = fs::remove_dir_all(&base);
        let source = base.join("card").join("_DSC0001.JPG");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        let payload = vec![3u8; 100 * 1024];
        fs::write(&source, &payload).unwrap();

        let dest_root = base.join("archive");
        let entry = FileEntry {
            path: source.to_string_lossy().to_string(),
            file_name: "_DSC0001.JPG".to_string(),
            stem: "_dsc0001".to_string(),
            ext: "jpg".to_string(),
            kind: MediaKind::Jpeg,
            size: payload.len() as u64,
            capture_date: "20261030".to_string(),
            capture_epoch: 0,
            core_num: Some(1),
        };

        let plan = plan_entries(vec![entry.clone()], &dest_root).unwrap();
        assert_eq!(plan.copied, 1);
        assert_eq!(plan.skipped_existing, 0);
        // 预演不能真的把文件或目录写出来。
        assert!(!dest_root.exists());

        // 预演之后再真实归档，结果应与预演一致。
        let real = archive_entries(vec![entry], &dest_root).unwrap();
        assert_eq!(real.copied, 1);
        assert!(dest_root.join("20261030").join("JPG").join("_DSC0001.JPG").exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn archive_dedupes_same_content_across_date_buckets() {
        let base = std::env::temp_dir().join("photoflow_dedupe_test");
        let _ = fs::remove_dir_all(&base);
        let source = base.join("card").join("_DSC8921.JPG");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        let payload = vec![7u8; 200 * 1024];
        fs::write(&source, &payload).unwrap();

        let dest_root = base.join("archive");
        let make_entry = |date: &str| FileEntry {
            path: source.to_string_lossy().to_string(),
            file_name: "_DSC8921.JPG".to_string(),
            stem: "_dsc8921".to_string(),
            ext: "jpg".to_string(),
            kind: MediaKind::Jpeg,
            size: payload.len() as u64,
            capture_date: date.to_string(),
            capture_epoch: 0,
            core_num: Some(8921),
        };

        let first = archive_entries(vec![make_entry("20261030")], &dest_root).unwrap();
        assert_eq!(first.copied, 1);
        assert_eq!(first.skipped_existing, 0);

        // 同一内容换到另一个日期桶再次导入：必须被归档库全局查重拦下。
        let second = archive_entries(vec![make_entry("20251111")], &dest_root).unwrap();
        assert_eq!(second.copied, 0);
        assert_eq!(second.skipped_existing, 1);

        let stored: Vec<_> = fs::read_dir(dest_root.join("20261030").join("JPG"))
            .unwrap()
            .filter_map(|item| item.ok())
            .collect();
        assert_eq!(stored.len(), 1);

        let _ = fs::remove_dir_all(&base);
    }
}

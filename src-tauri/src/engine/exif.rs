//! EXIF 拍摄日期读取：用于归档时按真实拍摄日期分桶，而非文件修改时间。

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

/// 读取 EXIF `DateTimeOriginal`（退回 `DateTime`），返回 `YYYYMMDD`。
///
/// 仅支持能直接解析的容器（JPEG / TIFF 系 RAW）。CR3、HEIC 等 ISO BMFF 容器
/// 读取失败时返回 `None`，由调用方回退到文件修改时间。
pub fn capture_date(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new()
        .read_from_container(&mut reader)
        .ok()?;

    let field = exif
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .or_else(|| exif.get_field(exif::Tag::DateTimeDigitized, exif::In::PRIMARY))
        .or_else(|| exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY))?;

    let exif::Value::Ascii(values) = &field.value else {
        return None;
    };
    let bytes = values.first()?;
    let text = String::from_utf8_lossy(bytes);

    // 标准格式 "2026:10:30 12:34:56"，取前 8 位数字；无效年份（0000）直接放弃。
    let digits: String = text.chars().take(10).filter(|c| c.is_ascii_digit()).collect();
    if digits.len() != 8 {
        return None;
    }
    let year = &digits[..4];
    if year == "0000" {
        return None;
    }
    Some(digits)
}

/// 读取 EXIF 完整拍摄时间（精确到秒），返回 Unix 时间戳。
///
/// 用于连拍分组：JPEG 的 DateTimeOriginal 通常是 "YYYY:MM:DD HH:MM:SS"，
/// 取不到时由调用方回退文件修改时间。
pub fn capture_timestamp(path: &Path) -> Option<i64> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new()
        .read_from_container(&mut reader)
        .ok()?;

    let field = exif
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .or_else(|| exif.get_field(exif::Tag::DateTimeDigitized, exif::In::PRIMARY))
        .or_else(|| exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY))?;

    let exif::Value::Ascii(values) = &field.value else {
        return None;
    };
    let bytes = values.first()?;
    let text = String::from_utf8_lossy(bytes);
    parse_timestamp(&text)
}

/// 将 EXIF ASCII 时间（"YYYY:MM:DD HH:MM:SS"）解析为 Unix 时间戳（按 UTC 解释）。
fn parse_timestamp(text: &str) -> Option<i64> {
    let digits: String = text
        .chars()
        .take(19)
        .filter(|value| value.is_ascii_digit())
        .collect();
    if digits.len() != 14 || digits.starts_with("0000") {
        return None;
    }
    let naive = chrono::NaiveDateTime::parse_from_str(&digits, "%Y%m%d%H%M%S").ok()?;
    Some(naive.and_utc().timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_returns_none() {
        assert!(capture_date(Path::new("D:\\__not_exists__.jpg")).is_none());
        assert!(capture_timestamp(Path::new("D:\\__not_exists__.jpg")).is_none());
    }

    #[test]
    fn parses_standard_exif_datetime() {
        // 2026-10-30 12:34:56 UTC
        assert_eq!(
            parse_timestamp("2026:10:30 12:34:56"),
            Some(1_793_363_696)
        );
    }

    #[test]
    fn rejects_invalid_exif_datetime() {
        assert!(parse_timestamp("0000:00:00 00:00:00").is_none());
        assert!(parse_timestamp("2026:10:30").is_none());
        assert!(parse_timestamp("").is_none());
        assert!(parse_timestamp("2026:13:45 99:99:99").is_none());
    }
}

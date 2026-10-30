//! 相机星标读写：读取 EXIF（0x4746 / 0x4749）与 XMP（xmp:Rating），
//! 写回时直接改写 JPEG 的 XMP APP1 段，Lightroom / Bridge 可直接识别。

use crate::engine::EngineError;
use std::io::BufReader;
use std::path::Path;

const RATING_TAG: u16 = 0x4746;
const RATING_PERCENT_TAG: u16 = 0x4749;
const XMP_NAMESPACE: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

/// 读取文件星标（1–5），未评级返回 `None`。先查 EXIF，再退回 XMP。
pub fn read_rating(path: &Path) -> Option<u8> {
    read_exif_rating(path).or_else(|| read_xmp_rating(path))
}

fn read_exif_rating(path: &Path) -> Option<u8> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new()
        .read_from_container(&mut reader)
        .ok()?;

    for field in exif.fields() {
        let number = field.tag.number();
        if number != RATING_TAG && number != RATING_PERCENT_TAG {
            continue;
        }
        let raw = match &field.value {
            exif::Value::Short(values) => values.first().copied().map(u32::from),
            exif::Value::Long(values) => values.first().copied(),
            _ => None,
        };
        let Some(raw) = raw else { continue };
        if raw == 0 {
            continue;
        }
        let stars = if number == RATING_PERCENT_TAG {
            ((raw as f32 / 100.0) * 5.0).round() as u8
        } else {
            raw.min(5) as u8
        };
        if stars > 0 {
            return Some(stars.min(5));
        }
    }
    None
}

fn read_xmp_rating(path: &Path) -> Option<u8> {
    let data = std::fs::read(path).ok()?;
    let limit = data.len().min(256 * 1024);
    find_xmp_rating(&data[..limit])
}

fn find_from(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() || from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|position| position + from)
}

/// 从 XMP 文本中解析 `xmp:Rating="N"` 或 `<xmp:Rating>N</xmp:Rating>`。
fn find_xmp_rating(data: &[u8]) -> Option<u8> {
    let token = b"xmp:Rating";
    let mut index = 0;
    while let Some(position) = find_from(data, token, index) {
        let mut cursor = position + token.len();
        while cursor < data.len() && matches!(data[cursor], b' ' | b'\t' | b'\r' | b'\n') {
            cursor += 1;
        }
        if cursor < data.len() && matches!(data[cursor], b'=' | b'>') {
            cursor += 1;
            while cursor < data.len()
                && matches!(data[cursor], b' ' | b'\t' | b'"' | b'\'' | b'\r' | b'\n')
            {
                cursor += 1;
            }
            let mut digits = String::new();
            while cursor < data.len() && data[cursor].is_ascii_digit() && digits.len() < 2 {
                digits.push(data[cursor] as char);
                cursor += 1;
            }
            if let Ok(value) = digits.parse::<u8>() {
                if value > 0 {
                    return Some(value.min(5));
                }
                return None;
            }
        }
        index = position + token.len();
    }
    None
}

/// 写回星标（0 表示清除）。目前仅支持 JPG，因为要改写 JPEG 的 XMP APP1 段。
pub fn write_rating(path: &Path, rating: u8) -> Result<(), EngineError> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "jpe") {
        return Err(EngineError::Decode(
            "星标写回目前仅支持 JPG（HEIC 等格式不写入）".to_string(),
        ));
    }

    let data = std::fs::read(path)?;
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return Err(EngineError::Decode("不是有效的 JPEG 文件".to_string()));
    }

    let rating = rating.min(5);
    let segment = match locate_xmp_segment(&data) {
        Some((start, end)) => {
            let payload_start = start + 4;
            let xmp_text = if data[payload_start..].starts_with(XMP_NAMESPACE) {
                String::from_utf8_lossy(&data[payload_start + XMP_NAMESPACE.len()..end]).to_string()
            } else {
                String::new()
            };
            build_app1(&patch_xmp(&xmp_text, rating))?
        }
        None => build_app1(&build_minimal_xmp(rating))?,
    };

    let output = if let Some((start, end)) = locate_xmp_segment(&data) {
        let mut out = Vec::with_capacity(data.len() + segment.len());
        out.extend_from_slice(&data[..start]);
        out.extend_from_slice(&segment);
        out.extend_from_slice(&data[end..]);
        out
    } else {
        let mut out = Vec::with_capacity(data.len() + segment.len());
        out.extend_from_slice(&data[..2]);
        out.extend_from_slice(&segment);
        out.extend_from_slice(&data[2..]);
        out
    };

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("photoflow");
    let temp = path.with_file_name(format!("{file_name}.photoflow.tmp"));
    std::fs::write(&temp, output)?;
    std::fs::rename(&temp, path)?;
    Ok(())
}

/// 在 JPEG 标记流中定位 XMP APP1 段，返回 [起始, 结束) 字节区间。
fn locate_xmp_segment(data: &[u8]) -> Option<(usize, usize)> {
    let mut index = 2usize;
    while index + 4 <= data.len() {
        if data[index] != 0xFF {
            return None;
        }
        let marker = data[index + 1];
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let length = u16::from_be_bytes([data[index + 2], data[index + 3]]) as usize;
        if length < 2 {
            return None;
        }
        let end = index + 2 + length;
        if end > data.len() {
            return None;
        }
        if marker == 0xE1 && data[index + 4..end].starts_with(XMP_NAMESPACE) {
            return Some((index, end));
        }
        index = end;
    }
    None
}

fn build_app1(xmp: &str) -> Result<Vec<u8>, EngineError> {
    let payload_length = XMP_NAMESPACE.len() + xmp.len() + 2;
    if payload_length > u16::MAX as usize {
        return Err(EngineError::Decode("XMP 数据过大，无法写入 APP1 段".to_string()));
    }
    let mut segment = Vec::with_capacity(payload_length + 2);
    segment.extend_from_slice(&[0xFF, 0xE1]);
    segment.extend_from_slice(&(payload_length as u16).to_be_bytes());
    segment.extend_from_slice(XMP_NAMESPACE);
    segment.extend_from_slice(xmp.as_bytes());
    Ok(segment)
}

fn build_minimal_xmp(rating: u8) -> String {
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
<rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmp:Rating=\"{rating}\"/>\n\
</rdf:RDF>\n\
</x:xmpmeta>\n\
<?xpacket end=\"w\"?>"
    )
}

/// 在已有 XMP 中替换（或插入）xmp:Rating，尽量保留其他元数据。
fn patch_xmp(existing: &str, rating: u8) -> String {
    let attribute = regex::Regex::new(r#"xmp:Rating\s*=\s*"[^"]*""#).expect("valid regex");
    if attribute.is_match(existing) {
        return attribute
            .replace(existing, format!("xmp:Rating=\"{rating}\""))
            .to_string();
    }

    let element = regex::Regex::new(r"<xmp:Rating>\s*\d+\s*</xmp:Rating>").expect("valid regex");
    if element.is_match(existing) {
        return element
            .replace(existing, format!("<xmp:Rating>{rating}</xmp:Rating>"))
            .to_string();
    }

    if let Some(position) = existing.find("</rdf:Description>") {
        let mut result = String::with_capacity(existing.len() + 30);
        result.push_str(&existing[..position]);
        result.push_str(&format!("<xmp:Rating>{rating}</xmp:Rating>"));
        result.push_str(&existing[position..]);
        return result;
    }

    build_minimal_xmp(rating)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn sample_jpeg(with_xmp: bool) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8];
        // APP0 JFIF
        bytes.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        bytes.extend_from_slice(b"JFIF\0");
        bytes.extend_from_slice(&[1, 1, 0, 0, 1, 0, 1, 0, 0]);
        if with_xmp {
            let xmp = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmp:Rating=\"2\" dc:format=\"image/jpeg\"/></rdf:RDF></x:xmpmeta>";
            let segment = build_app1(xmp).unwrap();
            bytes.extend_from_slice(&segment);
        }
        // 最简 SOS 之外直接 EOI，足以满足标记流解析
        bytes.extend_from_slice(&[0xFF, 0xD9]);
        bytes
    }

    fn temp_jpeg(name: &str, with_xmp: bool) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("photoflow_rating_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(&sample_jpeg(with_xmp)).unwrap();
        path
    }

    #[test]
    fn reads_xmp_attribute_rating() {
        let path = temp_jpeg("attr.jpg", true);
        assert_eq!(read_rating(&path), Some(2));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn writes_and_replaces_rating_once() {
        let path = temp_jpeg("write.jpg", true);
        write_rating(&path, 4).unwrap();
        assert_eq!(read_rating(&path), Some(4));

        let data = std::fs::read(&path).unwrap();
        let occurrences = data
            .windows(XMP_NAMESPACE.len())
            .filter(|window| *window == XMP_NAMESPACE)
            .count();
        assert_eq!(occurrences, 1, "不应产生重复的 XMP 段");

        write_rating(&path, 1).unwrap();
        assert_eq!(read_rating(&path), Some(1));

        write_rating(&path, 0).unwrap();
        assert_eq!(read_rating(&path), None, "0 星即清除标记");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn preserves_other_xmp_fields() {
        let path = temp_jpeg("preserve.jpg", true);
        write_rating(&path, 5).unwrap();
        let data = std::fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&data);
        assert!(text.contains("dc:format=\"image/jpeg\""), "原有 XMP 字段应保留");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn inserts_xmp_when_missing() {
        let path = temp_jpeg("insert.jpg", false);
        assert_eq!(read_rating(&path), None);
        write_rating(&path, 3).unwrap();
        assert_eq!(read_rating(&path), Some(3));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn parses_element_form_in_memory() {
        let data = b"<rdf:Description><xmp:Rating>4</xmp:Rating></rdf:Description>";
        assert_eq!(find_xmp_rating(data), Some(4));
        assert_eq!(find_xmp_rating(b"<rdf:Description/>"), None);
    }
}

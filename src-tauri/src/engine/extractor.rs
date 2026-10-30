use crate::engine::EngineError;
use crate::engine::decoder::ImageDecoder as _;
use base64::Engine as _;
use fast_image_resize::images::Image;
use fast_image_resize::{PixelType, ResizeOptions, Resizer};
use image::{ExtendedColorType, RgbImage};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// 高清内嵌预览的最小体积门槛（256KB）。
const MIN_PREVIEW_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOutcome {
    pub dest_path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// 在内存中扫描 JPEG SOI(0xFFD8) / EOI(0xFFD9) 标记，返回 (起始偏移, 长度)。
/// RAW 内嵌预览本身就是完整 JPEG，无需 Bayer 反马赛克即可直接取用。
pub fn scan_embedded_jpegs(data: &[u8], min_size: usize) -> Vec<(usize, usize)> {
    let mut found: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0usize;

    while cursor + 1 < data.len() {
        if data[cursor] == 0xFF && data[cursor + 1] == 0xD8 {
            let start = cursor;
            let mut probe = cursor + 2;
            let mut end: Option<usize> = None;

            while probe + 1 < data.len() {
                if data[probe] == 0xFF && data[probe + 1] == 0xD9 {
                    end = Some(probe + 2);
                    break;
                }
                probe += 1;
            }

            match end {
                Some(stop) => {
                    let length = stop - start;
                    if length >= min_size {
                        found.push((start, length));
                    }
                    cursor = stop;
                }
                None => break,
            }
        } else {
            cursor += 1;
        }
    }

    found
}

/// 读取 RAW 文件并抽取体积最大的内嵌 JPEG 预览。
pub fn extract_best_embedded_jpeg(raw_path: &Path) -> Result<Vec<u8>, EngineError> {
    let data = fs::read(raw_path)?;
    let candidates = scan_embedded_jpegs(&data, MIN_PREVIEW_BYTES);
    let best = candidates
        .iter()
        .max_by_key(|(_, length)| *length)
        .ok_or(EngineError::NoPreview)?;
    Ok(data[best.0..best.0 + best.1].to_vec())
}

/// 统一取图入口：JPG 直读、HEIC 走系统解码、RAW 抽内嵌全幅 JPEG。
/// 解码后按 EXIF Orientation 自动旋转，竖拍照片不会横躺。
pub fn load_preview_image(path: &Path) -> Result<RgbImage, EngineError> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let image = match ext.as_str() {
        "jpg" | "jpeg" | "jpe" => crate::engine::decoder::native_decoder().decode(path)?,
        "heic" | "heif" => crate::engine::decoder::heif_decoder().decode(path)?,
        _ => {
            let bytes = extract_best_embedded_jpeg(path)?;
            image::load_from_memory(&bytes)?.to_rgb8()
        }
    };

    Ok(apply_orientation(image, read_orientation(path)))
}

/// 读取 EXIF Orientation（1–8），任何失败都按 1（不旋转）处理。
fn read_orientation(path: &Path) -> u8 {
    use std::io::BufReader;

    let Ok(file) = fs::File::open(path) else {
        return 1;
    };
    let mut reader = BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) else {
        return 1;
    };
    let Some(field) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) else {
        return 1;
    };
    match field.value.get_uint(0) {
        Some(value) if (1..=8).contains(&value) => value as u8,
        _ => 1,
    }
}

/// 按 EXIF Orientation 旋转/镜像，方向 5–8 会交换宽高。
pub fn apply_orientation(source: RgbImage, orientation: u8) -> RgbImage {
    use image::imageops;

    match orientation {
        2 => imageops::flip_horizontal(&source),
        3 => imageops::rotate180(&source),
        4 => imageops::flip_vertical(&source),
        5 => imageops::flip_horizontal(&imageops::rotate90(&source)),
        6 => imageops::rotate90(&source),
        7 => imageops::flip_vertical(&imageops::rotate90(&source)),
        8 => imageops::rotate270(&source),
        _ => source,
    }
}

/// 用 fast_image_resize（SIMD）等比缩放长边，返回 (像素缓冲, 宽, 高)。
fn resize_rgb(
    source: RgbImage,
    max_edge: u32,
) -> Result<(Vec<u8>, u32, u32), EngineError> {
    let (src_w, src_h) = (source.width(), source.height());
    let max_edge = max_edge.clamp(64, 8000);

    if src_w.max(src_h) <= max_edge {
        return Ok((source.into_raw(), src_w, src_h));
    }

    let scale = max_edge as f64 / src_w.max(src_h) as f64;
    let dst_w = ((src_w as f64 * scale).round() as u32).max(1);
    let dst_h = ((src_h as f64 * scale).round() as u32).max(1);

    let input = Image::from_vec_u8(src_w, src_h, source.into_raw(), PixelType::U8x3)
        .map_err(|error| EngineError::Resize(format!("{error:?}")))?;
    let mut target = Image::new(dst_w, dst_h, PixelType::U8x3);
    let mut resizer = Resizer::new();
    resizer
        .resize(&input, &mut target, &ResizeOptions::new())
        .map_err(|error| EngineError::Resize(format!("{error:?}")))?;

    Ok((target.buffer().to_vec(), dst_w, dst_h))
}

fn encode_jpeg(pixels: &[u8], width: u32, height: u32, quality: u8) -> Result<Vec<u8>, EngineError> {
    let mut encoded: Vec<u8> = Vec::with_capacity(1024 * 256);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, quality);
    encoder.encode(pixels, width, height, ExtendedColorType::Rgb8)?;
    Ok(encoded)
}

/// 解码内嵌 JPEG，用 fast_image_resize（SIMD）等比缩放长边，再以指定质量重新压缩输出。
pub fn export_preview(
    raw_path: &Path,
    dest_path: &Path,
    max_edge: u32,
    quality: u8,
) -> Result<ExportOutcome, EngineError> {
    export_preview_with_limit(raw_path, dest_path, max_edge, quality, None)
}

/// 带目标体积上限的导出：先降质量（步长 8，最低 48），再降长边（每次 85%，最低 320px），
/// 直到文件不大于 `max_bytes`（`None` 或 0 表示不限）。
pub fn export_preview_with_limit(
    raw_path: &Path,
    dest_path: &Path,
    max_edge: u32,
    quality: u8,
    max_bytes: Option<u64>,
) -> Result<ExportOutcome, EngineError> {
    let source = load_preview_image(raw_path)?;
    let limit = max_bytes.unwrap_or(0);

    let mut edge = max_edge.clamp(64, 8000);
    let mut quality = quality.clamp(1, 100);

    let (mut pixels, mut width, mut height) = resize_rgb(source.clone(), edge)?;
    let mut encoded = encode_jpeg(&pixels, width, height, quality)?;

    while limit > 0 && encoded.len() as u64 > limit {
        if quality > 48 {
            quality = quality.saturating_sub(8).max(48);
        } else if edge > 320 {
            edge = (edge as f64 * 0.85).round().max(320.0) as u32;
            let resized = resize_rgb(source.clone(), edge)?;
            pixels = resized.0;
            width = resized.1;
            height = resized.2;
        } else {
            // 已到下限仍超出，接受当前结果，避免无限循环。
            break;
        }
        encoded = encode_jpeg(&pixels, width, height, quality)?;
    }

    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(dest_path, &encoded)?;

    Ok(ExportOutcome {
        dest_path: dest_path.to_string_lossy().to_string(),
        width,
        height,
        bytes: encoded.len() as u64,
    })
}

/// 按 90° 为单位的手动旋转（0–3），用于纠正 EXIF 缺失或方向错误的照片。
fn rotate_quarter(image: RgbImage, rotation: u32) -> RgbImage {
    use image::imageops;

    match rotation % 4 {
        1 => imageops::rotate90(&image),
        2 => imageops::rotate180(&image),
        3 => imageops::rotate270(&image),
        _ => image,
    }
}

/// 生成内联预览 data URL（JPEG/Base64）。max_edge 最大 8000，用于 1:1 焦点检查。
pub fn preview_data_url(
    path: &Path,
    max_edge: u32,
    quality: u8,
    rotation: u32,
) -> Result<String, EngineError> {
    let decoded = load_preview_image(path)?;
    let rotated = rotate_quarter(decoded, rotation);
    let (pixels, width, height) = resize_rgb(rotated, max_edge.clamp(64, 8000))?;
    let encoded = encode_jpeg(&pixels, width, height, quality.clamp(1, 100))?;
    let base64 = base64::engine::general_purpose::STANDARD.encode(&encoded);
    Ok(format!("data:image/jpeg;base64,{base64}"))
}

/// 生成内联缩略图 data URL（JPEG/Base64），供前端列表直接渲染。
pub fn thumbnail_data_url(path: &Path, max_edge: u32) -> Result<String, EngineError> {
    preview_data_url(path, max_edge.clamp(64, 2048), 72, 0)
}

/// 带手动旋转的缩略图（rotation 为 90° 的倍数，0–3）。
pub fn thumbnail_data_url_rotated(
    path: &Path,
    max_edge: u32,
    rotation: u32,
) -> Result<String, EngineError> {
    preview_data_url(path, max_edge.clamp(64, 2048), 72, rotation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_rotation_swaps_dimensions() {
        let image = RgbImage::from_pixel(4, 2, image::Rgb([10, 20, 30]));
        let rotated = rotate_quarter(image, 1);
        assert_eq!((rotated.width(), rotated.height()), (2, 4));
    }

    #[test]
    fn orientation_six_swaps_dimensions() {
        let image = RgbImage::from_pixel(4, 2, image::Rgb([10, 20, 30]));
        let rotated = apply_orientation(image, 6);
        assert_eq!((rotated.width(), rotated.height()), (2, 4));
    }

    #[test]
    fn orientation_one_keeps_dimensions() {
        let image = RgbImage::from_pixel(4, 2, image::Rgb([10, 20, 30]));
        let same = apply_orientation(image, 1);
        assert_eq!((same.width(), same.height()), (4, 2));
    }

    #[test]
    fn finds_jpeg_between_markers() {
        let mut data = vec![0u8; 16];
        let payload = vec![0xABu8; 400 * 1024];
        data.extend_from_slice(&[0xFF, 0xD8]);
        data.extend_from_slice(&payload);
        data.extend_from_slice(&[0xFF, 0xD9]);
        data.extend_from_slice(&[0u8; 16]);

        let found = scan_embedded_jpegs(&data, MIN_PREVIEW_BYTES);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1, payload.len() + 4);
    }

    #[test]
    fn ignores_tiny_previews() {
        let mut data = vec![0xFFu8, 0xD8, 0x00, 0x00, 0xFF, 0xD9];
        data.extend_from_slice(&[0u8; 8]);
        let found = scan_embedded_jpegs(&data, MIN_PREVIEW_BYTES);
        assert!(found.is_empty());
    }

    #[test]
    fn thumbnail_is_data_url() {
        let temp = std::env::temp_dir().join("photoflow_thumb_test.jpg");
        let image = RgbImage::from_pixel(64, 48, image::Rgb([120, 80, 200]));
        image.save(&temp).unwrap();
        let data_url = thumbnail_data_url(&temp, 160).unwrap();
        assert!(data_url.starts_with("data:image/jpeg;base64,"));
        let _ = fs::remove_file(&temp);
    }

    #[test]
    fn respects_max_bytes_limit() {
        let source = std::env::temp_dir().join("photoflow_limit_src.jpg");
        let image = RgbImage::from_fn(1200, 800, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        image.save(&source).unwrap();

        let dest = std::env::temp_dir().join("photoflow_limit_out.jpg");
        let limit = 40 * 1024u64;
        let outcome = export_preview_with_limit(&source, &dest, 2048, 90, Some(limit)).unwrap();
        assert!(outcome.bytes <= limit, "输出 {} 字节，超过上限 {limit}", outcome.bytes);

        let _ = fs::remove_file(&source);
        let _ = fs::remove_file(&dest);
    }
}

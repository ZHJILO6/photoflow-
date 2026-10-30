//! 跨平台图像解码抽象。
//!
//! 统一 `ImageDecoder` trait：Windows 的 HEIC 走 WIC 高速通道，
//! macOS 走系统 `sips`，其余格式与非 Windows 平台走纯 Rust 的 image crate 回退。
//! 调用方只面向 trait，不感知平台差异。

use crate::engine::EngineError;
use image::RgbImage;
use std::path::Path;

/// 统一解码接口：输入文件路径，输出 RGB 像素。
pub trait ImageDecoder: Send + Sync {
    fn decode(&self, path: &Path) -> Result<RgbImage, EngineError>;
}

/// 纯 Rust 解码（image 0.25）：JPEG / PNG 等常规格式，所有平台通用。
#[derive(Debug, Default)]
pub struct NativeImageDecoder;

impl ImageDecoder for NativeImageDecoder {
    fn decode(&self, path: &Path) -> Result<RgbImage, EngineError> {
        let bytes = std::fs::read(path)?;
        Ok(image::load_from_memory(&bytes)?.to_rgb8())
    }
}

/// 平台不支持 HEIC/HEIF 时的兜底实现：返回明确错误，而不是 panic。
#[derive(Debug, Default)]
pub struct UnsupportedHeifDecoder;

impl ImageDecoder for UnsupportedHeifDecoder {
    fn decode(&self, _path: &Path) -> Result<RgbImage, EngineError> {
        Err(EngineError::Decode(
            "当前平台暂不支持 HEIC/HEIF 解码（Windows 走 WIC，macOS 走系统 sips；Linux 建议先转成 JPG）"
                .to_string(),
        ))
    }
}

/// Windows：HEIC 走 WIC（依赖系统的「HEIF 图像扩展」）。
#[cfg(windows)]
#[derive(Debug, Default)]
pub struct WicHeifDecoder;

#[cfg(windows)]
impl ImageDecoder for WicHeifDecoder {
    fn decode(&self, path: &Path) -> Result<RgbImage, EngineError> {
        crate::engine::heif::decode_heif_rgb(path)
    }
}

/// macOS：HEIC 交给系统 `sips` 转临时 JPEG 再解码。
#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
pub struct SipsHeifDecoder;

#[cfg(target_os = "macos")]
impl ImageDecoder for SipsHeifDecoder {
    fn decode(&self, path: &Path) -> Result<RgbImage, EngineError> {
        crate::engine::heif::decode_heif_rgb(path)
    }
}

/// 常规格式解码器（跨平台）。
pub fn native_decoder() -> NativeImageDecoder {
    NativeImageDecoder
}

/// HEIC/HEIF 解码器（按平台编译期选择）。
#[cfg(windows)]
pub fn heif_decoder() -> &'static dyn ImageDecoder {
    static DECODER: WicHeifDecoder = WicHeifDecoder;
    &DECODER
}

#[cfg(target_os = "macos")]
pub fn heif_decoder() -> &'static dyn ImageDecoder {
    static DECODER: SipsHeifDecoder = SipsHeifDecoder;
    &DECODER
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn heif_decoder() -> &'static dyn ImageDecoder {
    static DECODER: UnsupportedHeifDecoder = UnsupportedHeifDecoder;
    &DECODER
}

/// 按扩展名分派：HEIC/HEIF 走平台实现，其余走纯 Rust 解码。
pub fn decode_by_extension(path: &Path, ext: &str) -> Result<RgbImage, EngineError> {
    match ext {
        "heic" | "heif" => heif_decoder().decode(path),
        _ => native_decoder().decode(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_decoder_reads_jpeg() {
        let dir = std::env::temp_dir().join(format!("photoflow-decoder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("decoder-check.jpg");
        let source = RgbImage::from_pixel(8, 6, image::Rgb([120, 30, 200]));
        source.save(&path).expect("write test jpeg");

        let decoded = native_decoder().decode(&path).expect("decode jpeg");
        assert_eq!((decoded.width(), decoded.height()), (8, 6));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn heif_decoder_reports_clear_error_for_missing_file() {
        let result = heif_decoder().decode(Path::new("__not_exists__.heic"));
        assert!(result.is_err());
    }
}

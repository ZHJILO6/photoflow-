//! HEIC / HEIF 解码。
//!
//! - Windows：走 Windows Imaging Component（WIC），依赖系统的「HEIF 图像扩展」。
//! - macOS：调用系统自带的 `sips` 转成临时 JPEG 再解码。
//! 两者失败时都返回明确错误，而不是静默失败。

use crate::engine::EngineError;
use std::path::Path;

#[cfg(windows)]
pub fn decode_heif_rgb(path: &Path) -> Result<image::RgbImage, EngineError> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Graphics::Imaging::{
        IWICBitmapSource, IWICImagingFactory, CLSID_WICImagingFactory2, GUID_WICPixelFormat24bppBGR,
        WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnLoad,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        // 阻塞线程池线程可能已初始化过 COM，重复初始化返回 S_FALSE 属正常。
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory2, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| EngineError::Decode(format!("WIC 初始化失败: {error}")))?;

        let decoder = factory
            .CreateDecoderFromFilename(
                PCWSTR(wide.as_ptr()),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnLoad,
            )
            .map_err(|error| {
                EngineError::Decode(format!(
                    "HEIC 解码器不可用（系统可能缺少「HEIF 图像扩展」）: {error}"
                ))
            })?;

        let frame = decoder
            .GetFrame(0)
            .map_err(|error| EngineError::Decode(format!("读取 HEIC 帧失败: {error}")))?;

        let source: IWICBitmapSource = windows::core::Interface::cast(&frame)
            .map_err(|error| EngineError::Decode(format!("转换 WIC 位图源失败: {error}")))?;

        let converter = factory
            .CreateFormatConverter()
            .map_err(|error| EngineError::Decode(format!("创建格式转换器失败: {error}")))?;

        converter
            .Initialize(
                &source,
                &GUID_WICPixelFormat24bppBGR,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(|error| EngineError::Decode(format!("HEIC 像素格式转换失败: {error}")))?;

        let (mut width, mut height) = (0u32, 0u32);
        source
            .GetSize(&mut width, &mut height)
            .map_err(|error| EngineError::Decode(format!("读取 HEIC 尺寸失败: {error}")))?;

        if width == 0 || height == 0 {
            return Err(EngineError::Decode("HEIC 尺寸为 0".to_string()));
        }

        let stride = width * 3;
        let mut buffer = vec![0u8; (stride as usize) * (height as usize)];
        converter
            .CopyPixels(std::ptr::null(), stride, &mut buffer)
            .map_err(|error| EngineError::Decode(format!("拷贝 HEIC 像素失败: {error}")))?;

        // WIC 输出为 BGR，转成 RGB 供后续统一处理。
        for pixel in buffer.chunks_exact_mut(3) {
            pixel.swap(0, 2);
        }

        image::RgbImage::from_raw(width, height, buffer)
            .ok_or_else(|| EngineError::Decode("HEIC 像素缓冲尺寸不匹配".to_string()))
    }
}

/// macOS 通过系统自带的 `sips` 把 HEIC 转成临时 JPEG，再用 image 解码。
#[cfg(target_os = "macos")]
pub fn decode_heif_rgb(path: &Path) -> Result<image::RgbImage, EngineError> {
    use std::process::Command;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp = std::env::temp_dir().join(format!("photoflow-heic-{stamp}.jpg"));

    let output = Command::new("sips")
        .args(["-s", "format", "jpeg", "-o"])
        .arg(&temp)
        .arg(path)
        .output()
        .map_err(|error| EngineError::Decode(format!("调用系统 sips 失败: {error}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(EngineError::Decode(format!(
            "HEIC 转换失败: {}",
            stderr.trim()
        )));
    }

    let decoded = image::open(&temp)
        .map_err(|error| EngineError::Decode(format!("HEIC 解码失败: {error}")))?;
    let _ = std::fs::remove_file(&temp);
    Ok(decoded.to_rgb8())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn decode_heif_rgb(_path: &Path) -> Result<image::RgbImage, EngineError> {
    Err(EngineError::Decode(
        "当前平台暂未实现 HEIC 解码（Windows 走 WIC，macOS 走 sips）".to_string(),
    ))
}

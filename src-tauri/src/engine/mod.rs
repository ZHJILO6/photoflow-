pub mod archiver;
pub mod decoder;
pub mod exif;
pub mod extractor;
pub mod heif;
pub mod indexer;
pub mod parser;
pub mod rating;
pub mod storage;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("路径无效: {0}")]
    InvalidPath(String),

    #[error("图像解码失败: {0}")]
    Image(#[from] image::ImageError),

    #[error("缩放失败: {0}")]
    Resize(String),

    #[error("未在 RAW 中找到大于 256KB 的内嵌 JPEG 预览")]
    NoPreview,

    #[error("解码失败: {0}")]
    Decode(String),

    #[error("哈希校验失败，目标文件可能损坏: {0}")]
    HashMismatch(String),

    #[error("线程任务失败: {0}")]
    Join(String),
}

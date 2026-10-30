//! 跨平台外接存储设备枚举。
//!
//! 统一返回 `{ name, path, is_removable }`：
//! - Windows：`GetLogicalDrives` + `GetDriveTypeW` 判定盘符类型
//! - macOS：扫描 `/Volumes`
//! - Linux：解析 `/proc/mounts`，取 `/media` 与 `/run/media` 下的挂载点

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StorageDevice {
    pub name: String,
    pub path: String,
    pub is_removable: bool,
}

/// 列出所有存储设备（含内置盘），已按路径排序去重。
pub fn list_storage_devices() -> Vec<StorageDevice> {
    let mut devices = platform_devices();
    devices.sort_by(|left, right| left.path.cmp(&right.path));
    devices.dedup_by(|left, right| left.path == right.path);
    devices
}

/// 只返回可移动设备（U 盘 / 读卡器），供插卡检测使用。
pub fn removable_devices() -> Vec<StorageDevice> {
    list_storage_devices()
        .into_iter()
        .filter(|device| device.is_removable)
        .collect()
}

#[cfg(windows)]
fn platform_devices() -> Vec<StorageDevice> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

    /// Win32 `DRIVE_REMOVABLE` 常量值。
    const DRIVE_REMOVABLE_TYPE: u32 = 2;

    let mask = unsafe { GetLogicalDrives() };
    let mut devices = Vec::new();
    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        // 盘符根目录是 Windows 平台的固定写法，后续拼接一律走 PathBuf。
        let root = std::path::PathBuf::from(format!("{letter}:\\"));
        if !root.exists() {
            continue;
        }

        let wide: Vec<u16> = root
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let drive_type = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };

        devices.push(StorageDevice {
            name: format!("{letter}:"),
            path: root.to_string_lossy().to_string(),
            is_removable: drive_type == DRIVE_REMOVABLE_TYPE,
        });
    }
    devices
}

#[cfg(target_os = "macos")]
fn platform_devices() -> Vec<StorageDevice> {
    let mut devices = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            devices.push(StorageDevice {
                name,
                path: entry.path().to_string_lossy().to_string(),
                // /Volumes 下除系统主卷外基本都是外接设备，主卷不会出现在此目录。
                is_removable: true,
            });
        }
    }
    devices
}

#[cfg(target_os = "linux")]
fn platform_devices() -> Vec<StorageDevice> {
    const MOUNT_BASES: [&str; 2] = ["/media/", "/run/media/"];

    let mut devices = Vec::new();
    if let Ok(mounts) = std::fs::read_to_string("/proc/mounts") {
        for line in mounts.lines() {
            let Some(mount) = line.split_whitespace().nth(1) else {
                continue;
            };
            // /proc/mounts 用 \040 转义空格。
            let mount = mount.replace("\\040", " ");
            if !MOUNT_BASES.iter().any(|base| mount.starts_with(base)) {
                continue;
            }
            let name = Path::new(&mount)
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| mount.clone());
            devices.push(StorageDevice {
                name,
                path: mount,
                is_removable: true,
            });
        }
    }
    devices
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn platform_devices() -> Vec<StorageDevice> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_have_absolute_paths_and_names() {
        for device in list_storage_devices() {
            assert!(!device.name.is_empty());
            assert!(Path::new(&device.path).is_absolute());
        }
    }

    #[test]
    fn removable_subset_matches_flag() {
        for device in removable_devices() {
            assert!(device.is_removable);
        }
    }
}

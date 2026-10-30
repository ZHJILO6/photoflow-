# PhotoFlow Picker

面向体育 / 活动摄影师的**照片入库去重工具**：把存储卡或硬盘上散乱的照片，按 EXIF 拍摄日期归位到固定目录结构，并在入库时用内容哈希查重，保证同一个文件永远不会在库里出现第二份。

> **它不替代 Lightroom。** 挑片、星标、导出这些 Lightroom 已经做得很好；本工具的价值在 LR 之前的那一段：不导入、不建预览，先把卡整理干净。

## 它能做什么

| 能力 | 说明 | Lightroom 能做吗 |
|---|---|---|
| 按拍摄日期自动归位 | `20261030/JPG/原名`，依据 EXIF `DateTimeOriginal`，不看文件名与目录结构 | 只能在导入那一刻做 |
| 内容级查重 | 体积分桶 + xxHash64，改名、换目录照样认得出 | 只能按文件名/时间猜 |
| 复制后回读校验 | 流式拷贝完再哈希比对，防止写坏 | 无 |
| 导入预演 | 先给出"将新增 / 已存在 / 重复 / 失败"，确认后才写盘 | 无 |
| 多副本清理 / 空目录清理 | 找出库里同一张照片的多份并删除 | 无 |
| 按序号区间找片 | `8921-8930` 一次定位一段连拍 | 需逐个子串搜 |
| RAW 内嵌预览导出 | 跳过反马赛克直接抽内嵌 JPEG，比常规解码快几十倍 | 需完整渲染 |
| 连拍挑片（可选） | 按拍摄间隔自动分组，P/X 标记，100% 判焦，断点续挑 | 比较视图 + Caps Lock 更快 |

## 它不做什么

- 不做非破坏性 RAW 冲图（这是 Lightroom / Capture One 的活）
- 不管理 LR 目录数据库，归档库是纯文件夹结构，随时可以重建
- 「连拍挑片」是可选环节：如果你已经习惯 Lightroom 的比较视图 + Caps Lock 自动前进，直接跳过这一页即可

## 典型工作流

```
存储卡 / 乱文件夹
      ↓  卡导入：按日期归位 + 哈希查重 + 读回校验
D:\照片库\20261030\JPG\...
      ↓  （可选）连拍挑片：P 保留 / X 淘汰
      ↓  复制保留原片（原样复制，不重新编码）
D:\2026-10-30_交付\...
      ↓
Lightroom 导入交付目录 → 精修 → 批处理出片
```

## 快捷键（连拍挑片页）

| 键 | 作用 |
| --- | --- |
| `P` / `X` / `U` | 保留 / 淘汰 / 撤销 |
| `←` `→` | 上一张 / 下一张 |
| `Shift + ← →` | 整组跳转 |
| `Z` | 切换 100% 原分辨率视图（可鼠标拖动平移） |
| `[` `]` | 逆时针 / 顺时针旋转 90° |
| `1` `2` `3` `4` | 筛选：全部 / 保留 / 淘汰 / 未标记 |

挑片进度会落盘，关掉软件再打开会自动回到上次的目录并恢复标记。

## 安装

### macOS

从 [Releases](../../releases) 或 Actions 的 Artifacts 下载 dmg，拖入「应用程序」。

首次打开若提示「无法验证开发者」，执行一次：

```bash
xattr -dr com.apple.quarantine "/Applications/PhotoFlow Picker.app"
```

### Windows

`npm run tauri build` 生成 `src-tauri/target/release/bundle/` 下的 msi / exe。

## 开发

```bash
npm install
npm run tauri dev      # 开发模式
npm run build          # 前端类型检查 + 构建
cd src-tauri && cargo test
```

技术栈：Tauri 2 · Rust（rayon / fast_image_resize / kamadak-exif / twox-hash）· React 18 · TypeScript · Tailwind CSS。

macOS 安装包由 GitHub Actions 云端构建（`.github/workflows/build-macos.yml`），同时产出 Apple Silicon 与 Intel 两个架构。

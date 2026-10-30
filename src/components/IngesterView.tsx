import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  ArrowRight,
  Copy,
  FolderInput,
  FolderOpen,
  HardDriveDownload,
  Info,
  Loader2,
  ScanSearch,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AppSettings,
  ArchiveReport,
  ArchiveStats,
  CleanupReport,
  DuplicateGroup,
  MatchedFile,
  ScanReport,
} from "../types";

interface IngesterViewProps {
  archiveDir: string;
  onArchiveDirChange: (value: string) => void;
  scan: ScanReport | null;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

type Tone = "ok" | "err" | "info";

interface StatusMessage {
  tone: Tone;
  text: string;
}

const rules = [
  { label: "拍摄日期层", value: "{YYYYMMDD}", hint: "取文件修改时间，缺失时使用 00000000" },
  { label: "素材类型层", value: "RAW / JPG / OTHER", hint: "按扩展名自动分流" },
  { label: "原文件名", value: "{original_name}", hint: "不重命名，重名冲突自动追加 _1" },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export default function IngesterView({
  archiveDir,
  onArchiveDirChange,
  scan,
  settings,
  onSettingsChange,
}: IngesterViewProps) {
  const [cardDir, setCardDir] = useState("");
  const [cardReport, setCardReport] = useState<ScanReport | null>(null);
  const [importReport, setImportReport] = useState<ArchiveReport | null>(null);
  const [busy, setBusy] = useState<"scan" | "import" | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  const [archiveStats, setArchiveStats] = useState<ArchiveStats | null>(null);
  const [archiveScanning, setArchiveScanning] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MatchedFile[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[] | null>(null);
  const [dupScanning, setDupScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 6000);
    return () => clearTimeout(timer);
  }, [status]);

  const runScan = async (root: string) => {
    setBusy("scan");
    setImportReport(null);
    try {
      const result = await invoke<ScanReport>("scan_card", { cardDir: root });
      setCardReport(result);
      setStatus({
        tone: "ok",
        text: `卡内素材：${result.total.toLocaleString()} 个 · RAW ${result.raw_count} · JPG ${result.jpeg_count} · ${result.duration_ms} ms`,
      });
    } catch (error) {
      setCardReport(null);
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setBusy(null);
    }
  };

  const runImport = async (root: string, dest: string) => {
    setBusy("import");
    try {
      const result = await invoke<ArchiveReport>("import_card", {
        cardDir: root,
        destDir: dest,
      });
      setImportReport(result);
      const failNote = result.failed.length > 0 ? ` · 失败 ${result.failed.length}` : "";
      setStatus({
        tone: result.failed.length > 0 ? "err" : "ok",
        text: `导入完成 · 新增 ${result.copied} · 库内已存在跳过 ${result.skipped_existing} · 批内重复跳过 ${result.skipped_duplicates}${failNote} · ${result.duration_ms} ms`,
      });
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setBusy(null);
    }
  };

  // 插入可移动盘时由 Rust 侧推送 card-detected：自动代入卡目录，必要时弹窗或直接导入。
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<{ root: string }>("card-detected", (event) => {
      const root = event.payload.root;
      setCardDir(root);
      setCardReport(null);

      const dest = archiveDir.trim();
      if (settings.autoImport && dest) {
        setDetected(null);
        setStatus({ tone: "info", text: `检测到存储卡 ${root}，正在自动导入…` });
        void runImport(root, dest);
        return;
      }

      setDetected(root);
      if (settings.autoImport) {
        setStatus({
          tone: "err",
          text: `检测到存储卡 ${root}，但归档目录未设置，已取消自动导入`,
        });
      } else {
        setStatus({ tone: "info", text: `检测到存储卡 ${root}，请选择处理方式` });
      }
    })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => {
        // 监听失败不影响手动流程。
      });

    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archiveDir, settings.autoImport]);

  const pickDirectory = async (
    current: string,
    apply: (value: string) => void,
    title: string
  ) => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title,
        defaultPath: current.trim() || undefined,
      });
      if (typeof selected === "string" && selected.trim()) {
        apply(selected);
        setStatus({ tone: "info", text: `已选择目录：${selected}` });
      }
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    }
  };

  const handleScanCard = async () => {
    if (!cardDir.trim()) {
      setStatus({ tone: "err", text: "请先选择存储卡根目录" });
      return;
    }
    await runScan(cardDir.trim());
  };

  const handleImport = async () => {
    if (!cardDir.trim()) {
      setStatus({ tone: "err", text: "请先选择存储卡根目录" });
      return;
    }
    if (!archiveDir.trim()) {
      setStatus({ tone: "err", text: "请先选择归档根目录" });
      return;
    }
    await runImport(cardDir.trim(), archiveDir.trim());
  };

  const handleScanArchive = async () => {
    if (!archiveDir.trim()) {
      setStatus({ tone: "err", text: "请先选择归档根目录" });
      return;
    }
    setArchiveScanning(true);
    try {
      const result = await invoke<ArchiveStats>("scan_archive", {
        rootDir: archiveDir.trim(),
      });
      setArchiveStats(result);
      setStatus({
        tone: "ok",
        text: `归档库：${result.buckets.length} 个日期桶 · ${result.total_files} 个文件 · ${formatBytes(
          result.total_bytes
        )} · ${result.duration_ms} ms`,
      });
    } catch (error) {
      setArchiveStats(null);
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setArchiveScanning(false);
    }
  };

  const handleOpenArchive = async () => {
    if (!archiveDir.trim()) {
      setStatus({ tone: "err", text: "请先选择归档根目录" });
      return;
    }
    try {
      await invoke("open_archive_dir", { path: archiveDir.trim() });
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    }
  };

  const openContainingDir = async (filePath: string) => {
    const parent = filePath.replace(/[\\/][^\\/]+$/, "");
    if (!parent) return;
    try {
      await invoke("open_archive_dir", { path: parent });
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    }
  };

  const handleSearchArchive = async () => {
    if (!archiveDir.trim()) {
      setStatus({ tone: "err", text: "请先选择归档根目录" });
      return;
    }
    setSearching(true);
    try {
      const result = await invoke<MatchedFile[]>("search_archive", {
        rootDir: archiveDir.trim(),
        queryText: searchQuery.trim(),
      });
      setSearchResults(result);
      setStatus({
        tone: "ok",
        text: searchQuery.trim()
          ? `归档检索：命中 ${result.length} 个文件`
          : `归档浏览：共 ${result.length} 个文件`,
      });
    } catch (error) {
      setSearchResults(null);
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setSearching(false);
    }
  };

  const handleFindDuplicates = async () => {
    if (!archiveDir.trim()) {
      setStatus({ tone: "err", text: "请先选择归档根目录" });
      return;
    }
    setDupScanning(true);
    try {
      const result = await invoke<DuplicateGroup[]>("find_archive_duplicates", {
        rootDir: archiveDir.trim(),
      });
      setDuplicates(result);
      setStatus({
        tone: result.length > 0 ? "info" : "ok",
        text:
          result.length > 0
            ? `发现 ${result.length} 组重复内容，可删除多余副本`
            : "归档库中没有内容重复的文件",
      });
    } catch (error) {
      setDuplicates(null);
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setDupScanning(false);
    }
  };

  const refreshArchive = async () => {
    try {
      const stats = await invoke<ArchiveStats>("scan_archive", {
        rootDir: archiveDir.trim(),
      });
      setArchiveStats(stats);
    } catch {
      setArchiveStats(null);
    }
  };

  const handleCleanupDuplicates = async () => {
    if (!archiveDir.trim() || !duplicates || duplicates.length === 0) return;
    const redundant = duplicates.reduce((sum, group) => sum + group.files.length - 1, 0);
    if (
      !window.confirm(
        `将删除 ${redundant} 个重复副本（每组保留路径排序第一个），释放约 ${formatBytes(
          duplicates.reduce((sum, group) => sum + group.size * (group.files.length - 1), 0)
        )}。此操作不可撤销，是否继续？`
      )
    ) {
      return;
    }

    setCleaning(true);
    try {
      const report = await invoke<CleanupReport>("cleanup_archive_duplicates", {
        rootDir: archiveDir.trim(),
      });
      setDuplicates([]);
      await refreshArchive();
      await handleSearchArchive();
      setStatus({
        tone: report.failed.length > 0 ? "err" : "ok",
        text: `清理完成 · 删除 ${report.removed_files} 个重复文件 · 释放 ${formatBytes(
          report.freed_bytes
        )} · 清理空目录 ${report.removed_dirs}${
          report.failed.length > 0 ? ` · 失败 ${report.failed.length}` : ""
        }`,
      });
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setCleaning(false);
    }
  };

  const handleCleanupEmptyDirs = async () => {
    if (!archiveDir.trim()) {
      setStatus({ tone: "err", text: "请先选择归档根目录" });
      return;
    }
    if (!window.confirm("将删除归档库中所有空目录（不影响文件），是否继续？")) return;

    setCleaning(true);
    try {
      const report = await invoke<CleanupReport>("cleanup_empty_dirs", {
        rootDir: archiveDir.trim(),
      });
      setStatus({
        tone: "ok",
        text: `已清理空目录 ${report.removed_dirs} 个 · ${report.duration_ms} ms`,
      });
      await refreshArchive();
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setCleaning(false);
    }
  };

  const toneClass = (tone: Tone) => {
    if (tone === "ok") return "text-success";
    if (tone === "err") return "text-danger";
    return "text-zinc-400";
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-4 border-b border-white/5 px-6 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold tracking-tight text-zinc-100">卡导入与归档</p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            xxHash64 秒级去重 · 2MB 缓冲流式写入 · 复制后回读校验防坏块
          </p>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-white/5 bg-ink-900/60 px-3 py-2">
          <Settings2 size={13} className="text-zinc-600" />
          <span className="text-[12px] text-zinc-400">插卡后自动导入</span>
          <button
            type="button"
            role="switch"
            aria-checked={settings.autoImport}
            title={
              settings.autoImport
                ? "检测到存储卡后自动导入到归档目录"
                : "开启后检测到存储卡会自动开始导入"
            }
            onClick={() =>
              onSettingsChange({ ...settings, autoImport: !settings.autoImport })
            }
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              settings.autoImport ? "bg-accent" : "bg-ink-600"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                settings.autoImport ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-6 py-5 lg:grid-cols-[1.1fr_1fr]">
        <section className="panel flex flex-col">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <FolderInput size={14} className="text-accent" />
              <span className="text-[13px] font-medium text-zinc-200">存储卡导入</span>
            </div>
            {cardReport && (
              <span className="font-mono text-[11px] text-zinc-500">
                {cardReport.total.toLocaleString()} files
              </span>
            )}
          </div>

          <div className="space-y-4 p-4">
            <div>
              <label className="label" htmlFor="card-root">
                存储卡根目录
              </label>
              <div className="relative">
                <input
                  id="card-root"
                  className="field pr-9"
                  placeholder="例如 E:\\DCIM 或整卡根目录"
                  value={cardDir}
                  onChange={(event) => setCardDir(event.target.value)}
                />
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 transition hover:text-accent"
                  title="选择存储卡根目录"
                  onClick={() => void pickDirectory(cardDir, setCardDir, "选择存储卡根目录")}
                >
                  <FolderOpen size={14} />
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="btn-muted"
                  onClick={() => void handleScanCard()}
                  disabled={busy !== null}
                >
                  {busy === "scan" ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <ScanSearch size={13} />
                  )}
                  扫描卡内素材
                </button>
                {cardReport && (
                  <div className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                    <span className="chip">
                      <span className="text-zinc-600">RAW</span>
                      <span className="text-accent">{cardReport.raw_count}</span>
                    </span>
                    <span className="chip">
                      <span className="text-zinc-600">JPG</span>
                      <span className="text-success">{cardReport.jpeg_count}</span>
                    </span>
                    <span className="chip">
                      <span className="text-zinc-600">scan</span>
                      <span className="text-zinc-300">{cardReport.duration_ms} ms</span>
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-center text-zinc-600">
              <ArrowRight size={14} />
            </div>

            <div>
              <label className="label" htmlFor="archive-root">
                Archive Root
              </label>
              <div className="relative">
                <input
                  id="archive-root"
                  className="field pr-9"
                  placeholder="D:\\PhotoFlow_Archive"
                  value={archiveDir}
                  onChange={(event) => onArchiveDirChange(event.target.value)}
                />
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 transition hover:text-accent"
                  title="选择归档根目录"
                  onClick={() =>
                    void pickDirectory(archiveDir, onArchiveDirChange, "选择归档根目录")
                  }
                >
                  <FolderOpen size={14} />
                </button>
              </div>
            </div>

            <button
              type="button"
              className="btn-primary w-full justify-center"
              onClick={() => void handleImport()}
              disabled={busy !== null}
            >
              {busy === "import" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <HardDriveDownload size={14} />
              )}
              {busy === "import" ? "导入中" : "一键导入整卡"}
            </button>

            {importReport && (
              <div className="rounded-lg border border-white/5 bg-ink-900/60 p-3">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
                  Last Import
                </p>
                <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                  <span className="text-success">新增 {importReport.copied}</span>
                  <span className="text-zinc-400">已存在 {importReport.skipped_existing}</span>
                  <span className="text-zinc-400">重复 {importReport.skipped_duplicates}</span>
                </div>
                {importReport.failed.length > 0 && (
                  <p className="mt-2 line-clamp-2 font-mono text-[10px] text-danger">
                    失败 {importReport.failed.length}：{importReport.failed[0]}
                  </p>
                )}
              </div>
            )}

            {status && (
              <div className="flex items-center gap-2">
                <span
                  className={`dot ${
                    status.tone === "ok"
                      ? "bg-success"
                      : status.tone === "err"
                      ? "bg-danger"
                      : "bg-zinc-500"
                  }`}
                />
                <p className={`font-mono text-[11px] ${toneClass(status.tone)}`}>{status.text}</p>
                <button
                  type="button"
                  className="ml-auto text-zinc-600 hover:text-zinc-400"
                  onClick={() => setStatus(null)}
                >
                  <X size={12} />
                </button>
              </div>
            )}

            <div className="rounded-lg border border-accent/20 bg-accent/5 p-3">
              <div className="flex items-start gap-2">
                <Info size={13} className="mt-0.5 shrink-0 text-accent" />
                <p className="text-[11px] leading-5 text-zinc-400">
                  导入前会对归档目录做「体积 + xxHash64」全局查重：同一张卡重复导入、或先按匹配结果
                  复制再整卡导入，都不会产生第二份相同内容。
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="panel flex min-h-0 flex-col">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Archive size={14} className="text-success" />
              <span className="text-[13px] font-medium text-zinc-200">归档库</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="btn-muted px-2 py-1 text-[11px]"
                onClick={() => void handleScanArchive()}
                disabled={busy !== null || archiveScanning}
                title="扫描归档目录并统计日期桶"
              >
                {archiveScanning ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <ScanSearch size={12} />
                )}
                {archiveScanning ? "扫描中" : "扫描归档"}
              </button>
              <button
                type="button"
                className="btn-muted px-2 py-1 text-[11px]"
                onClick={() => void handleOpenArchive()}
                disabled={!archiveDir.trim()}
                title="在资源管理器中打开归档目录"
              >
                <FolderOpen size={12} />
                打开
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {!archiveStats && (
              <div className="rounded-lg border border-white/5 bg-ink-900/60 p-3">
                <p className="text-[12px] text-zinc-400">尚未扫描归档库</p>
                <p className="mt-1 text-[11px] text-zinc-600">
                  先设置左侧的归档根目录，再点击「扫描归档」，即可按日期桶查看 RAW / JPG 分布与体积占用。
                </p>
              </div>
            )}

            {archiveStats && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { title: "文件总数", value: archiveStats.total_files.toLocaleString() },
                    { title: "日期桶", value: archiveStats.buckets.length.toLocaleString() },
                    { title: "RAW", value: archiveStats.raw_count.toLocaleString() },
                    { title: "JPG", value: archiveStats.jpeg_count.toLocaleString() },
                  ].map((item) => (
                    <div
                      key={item.title}
                      className="rounded-lg border border-white/5 bg-ink-900/60 px-3 py-2"
                    >
                      <p className="font-mono text-[15px] text-zinc-100">{item.value}</p>
                      <p className="mt-0.5 text-[11px] text-zinc-500">{item.title}</p>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg border border-white/5 bg-ink-900/60 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-zinc-300">占用体积</span>
                    <span className="font-mono text-[12px] text-accent">
                      {formatBytes(archiveStats.total_bytes)}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-zinc-600">
                    {archiveStats.root} · {archiveStats.duration_ms} ms
                  </p>
                </div>

                <div className="space-y-1.5">
                  {archiveStats.buckets.length === 0 && (
                    <p className="px-1 text-[11px] text-zinc-600">归档目录下还没有日期桶</p>
                  )}
                  {archiveStats.buckets.map((bucket) => (
                    <div
                      key={bucket.date}
                      className="flex items-center gap-2 rounded-md border border-white/5 bg-ink-900/60 px-3 py-1.5"
                    >
                      <span className="dot bg-success" />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">
                        {bucket.date}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-accent">
                        RAW {bucket.raw}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-success">
                        JPG {bucket.jpeg}
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-[10px] text-zinc-600">
                        {formatBytes(bucket.bytes)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="rounded-lg border border-white/5 bg-ink-900/60 p-3">
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
                归档检索
              </p>
              <div className="flex items-center gap-2">
                <input
                  className="field flex-1"
                  placeholder="序号或文件名，如 8921 / 8921-25（留空浏览全部）"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleSearchArchive();
                  }}
                />
                <button
                  type="button"
                  className="btn-muted shrink-0 px-2 py-1 text-[11px]"
                  onClick={() => void handleSearchArchive()}
                  disabled={searching || busy !== null}
                >
                  {searching ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Search size={12} />
                  )}
                  {searching ? "检索中" : "检索"}
                </button>
              </div>

              {searchResults && (
                <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                  {searchResults.length === 0 && (
                    <p className="px-1 text-[11px] text-zinc-600">没有命中任何归档文件</p>
                  )}
                  {searchResults.slice(0, 60).map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => void openContainingDir(file.path)}
                      title={file.path}
                      className="flex w-full items-center gap-2 rounded-md border border-white/5 px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                    >
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                          file.kind === "RAW"
                            ? "border-accent/30 text-accent"
                            : "border-success/30 text-success"
                        }`}
                      >
                        {file.kind}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-300">
                        {file.file_name}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                        {formatBytes(file.size)}
                      </span>
                    </button>
                  ))}
                  {searchResults.length > 60 && (
                    <p className="px-1 text-[10px] text-zinc-600">
                      仅显示前 60 条，共 {searchResults.length} 条
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-white/5 bg-ink-900/60 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
                  归档清理
                </p>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="btn-muted px-2 py-1 text-[11px]"
                    onClick={() => void handleFindDuplicates()}
                    disabled={dupScanning || cleaning || busy !== null}
                    title="按体积 + xxHash64 查找内容重复的文件"
                  >
                    {dupScanning ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Copy size={12} />
                    )}
                    {dupScanning ? "扫描中" : "查重复"}
                  </button>
                  <button
                    type="button"
                    className="btn-muted px-2 py-1 text-[11px]"
                    onClick={() => void handleCleanupEmptyDirs()}
                    disabled={cleaning || busy !== null}
                    title="删除归档库中的空目录，不影响文件"
                  >
                    <Trash2 size={12} />
                    清空目录
                  </button>
                </div>
              </div>

              {duplicates && duplicates.length === 0 && (
                <p className="px-1 text-[11px] text-zinc-600">没有发现重复文件</p>
              )}
              {duplicates && duplicates.length > 0 && (
                <div className="space-y-2">
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {duplicates.slice(0, 30).map((group) => (
                      <div
                        key={`${group.hash}-${group.size}`}
                        className="rounded-md border border-white/5 px-2 py-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[10px] text-zinc-500">
                            {formatBytes(group.size)} · {group.files.length} 份
                          </span>
                          <span className="font-mono text-[9px] text-zinc-700">#{group.hash}</span>
                        </div>
                        <p className="mt-1 truncate text-[11px] text-zinc-400" title={group.files[0]}>
                          保留：{group.files[0]}
                        </p>
                        <p
                          className="truncate text-[11px] text-danger"
                          title={group.files.slice(1).join("\n")}
                        >
                          删除：{group.files.slice(1).join("、")}
                        </p>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn-muted w-full justify-center px-2 py-1.5 text-[11px]"
                    onClick={() => void handleCleanupDuplicates()}
                    disabled={cleaning || busy !== null}
                  >
                    {cleaning ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                    删除{" "}
                    {duplicates.reduce((sum, group) => sum + group.files.length - 1, 0)}{" "}
                    个多余副本
                  </button>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-white/5 bg-ink-900/60 p-3">
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
                分流规则
              </p>
              <div className="space-y-1">
                {rules.map((rule) => (
                  <div key={rule.label} className="flex items-center justify-between gap-2">
                    <span className="shrink-0 text-[11px] text-zinc-400">{rule.label}</span>
                    <span className="truncate font-mono text-[10px] text-success" title={rule.hint}>
                      {rule.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-white/5 bg-ink-900/60 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-zinc-300">当前索引</span>
                <span className="font-mono text-[11px] text-zinc-300">
                  {scan ? `${scan.total.toLocaleString()} files` : "未建立"}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-zinc-600">
                {scan
                  ? `RAW ${scan.raw_count} · JPG ${scan.jpeg_count} · 扫描 ${scan.duration_ms} ms`
                  : "请先在「快速找片」中建立索引"}
              </p>
            </div>
          </div>
        </section>
      </div>

      {detected && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-6">
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-ink-900 p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-success/10 ring-1 ring-success/30">
                <HardDriveDownload size={16} className="text-success" />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-zinc-100">检测到存储卡</p>
                <p className="mt-1 truncate font-mono text-[11px] text-zinc-400" title={detected}>
                  {detected}
                </p>
                <p className="mt-2 text-[11px] leading-5 text-zinc-500">
                  {archiveDir.trim()
                    ? `导入将写入归档目录 ${archiveDir.trim()}，并自动做全局去重。`
                    : "尚未设置归档目录，导入前需先选择归档根目录。"}
                </p>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="btn-muted"
                onClick={() => setDetected(null)}
              >
                忽略
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  void runScan(detected);
                  setDetected(null);
                }}
              >
                <ScanSearch size={14} />
                仅扫描
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  void handleImport();
                  setDetected(null);
                }}
                disabled={!archiveDir.trim()}
              >
                <HardDriveDownload size={14} />
                立即导入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

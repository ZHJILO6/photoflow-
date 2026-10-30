import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ArrowLeftRight,
  ClipboardPaste,
  Copy,
  FileImage,
  FileSpreadsheet,
  FolderOpen,
  FolderSearch,
  Image as ImageIcon,
  Loader2,
  ScanSearch,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  ArchiveReport,
  ExportOutcome,
  MatchPair,
  MatchReport,
  ScanReport,
} from "../types";

interface MatcherViewProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  scan: ScanReport | null;
  onScanChange: (report: ScanReport | null) => void;
  exportDir: string;
  onExportDirChange: (value: string) => void;
  archiveDir: string;
  onArchiveDirChange: (value: string) => void;
}

type PairMode = "both" | "raw" | "jpeg";

type Tone = "ok" | "err" | "info";

interface StatusMessage {
  tone: Tone;
  text: string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function joinPath(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const separator = trimmed.includes("\\") ? "\\" : "/";
  return `${trimmed}${separator}${name}`;
}

function toneClass(tone: Tone): string {
  if (tone === "ok") return "text-success";
  if (tone === "err") return "text-danger";
  return "text-zinc-400";
}

export default function MatcherView({
  settings,
  onSettingsChange,
  scan,
  onScanChange,
  exportDir,
  onExportDirChange,
  archiveDir,
  onArchiveDirChange,
}: MatcherViewProps) {
  const [sourceDir, setSourceDir] = useState("");
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<MatchReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [matching, setMatching] = useState(false);
  const [busy, setBusy] = useState<"copy" | "export" | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [pairMode, setPairMode] = useState<PairMode>("both");
  const [showParams, setShowParams] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 6000);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!scan) {
      setReport(null);
      return;
    }

    const text = query.trim();
    if (!text) {
      setReport(null);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        setMatching(true);
        const next = await invoke<MatchReport>("match_files", { queryText: text });
        setReport(next);
      } catch (error) {
        setStatus({ tone: "err", text: String(error) });
      } finally {
        setMatching(false);
      }
    }, 260);

    return () => clearTimeout(timer);
  }, [query, scan]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setQuery("");
        setStatus({ tone: "info", text: "已清空查询文本" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleScan = async () => {
    if (!sourceDir.trim()) {
      setStatus({ tone: "err", text: "请先填写素材根目录" });
      return;
    }
    setScanning(true);
    setStatus(null);
    try {
      const result = await invoke<ScanReport>("scan_library", {
        rootDir: sourceDir.trim(),
      });
      onScanChange(result);
      setStatus({
        tone: "ok",
        text: `索引完成 · ${result.total.toLocaleString()} 个文件 · ${result.duration_ms} ms`,
      });
    } catch (error) {
      onScanChange(null);
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setScanning(false);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setStatus({ tone: "info", text: "剪贴板为空" });
        return;
      }
      setQuery((previous) => (previous ? `${previous.trimEnd()}\n${text}` : text));
      setStatus({ tone: "ok", text: "已从剪贴板粘贴" });
    } catch {
      setStatus({ tone: "err", text: "无法读取剪贴板，请直接在输入框内 Ctrl+V" });
    }
  };

  const browseDirectory = async (
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

  const filteredHits = useMemo(() => {
    if (!report) return [];
    if (pairMode === "raw") return report.hits.filter((pair) => pair.raw !== null);
    if (pairMode === "jpeg") return report.hits.filter((pair) => pair.jpeg !== null);
    return report.hits;
  }, [report, pairMode]);

  const matchedPaths = useMemo(() => {
    if (!report) return [];
    return filteredHits.flatMap((pair) =>
      [pair.raw?.path, pair.jpeg?.path].filter((value): value is string => Boolean(value))
    );
  }, [report, filteredHits]);

  const rawFiles = useMemo(() => {
    if (!report) return [];
    return filteredHits
      .map((pair) => pair.raw)
      .filter((value): value is NonNullable<typeof value> => Boolean(value));
  }, [report, filteredHits]);

  const handleLockPair = (pair: MatchPair) => {
    const target = pair.jpeg?.file_name ?? pair.raw?.file_name;
    if (!target) return;
    setQuery(target);
    setPairMode("both");
    setStatus({
      tone: "info",
      text: `已锁定 ${pair.core_num !== null ? `#${pair.core_num}` : target}，正在双向反查 RAW / JPG`,
    });
  };

  const handleCopy = async () => {
    if (!report || matchedPaths.length === 0) {
      setStatus({ tone: "err", text: "当前没有可复制的匹配项" });
      return;
    }
    if (!archiveDir.trim()) {
      setStatus({ tone: "err", text: "请先填写归档目标目录" });
      return;
    }

    setBusy("copy");
    try {
      const result = await invoke<ArchiveReport>("copy_matched", {
        paths: matchedPaths,
        destDir: archiveDir.trim(),
      });
      const failNote = result.failed.length > 0 ? ` · 失败 ${result.failed.length}` : "";
      setStatus({
        tone: result.failed.length > 0 ? "err" : "ok",
        text: `复制完成 · 新增 ${result.copied} · 重复跳过 ${result.skipped_duplicates} · 已存在 ${result.skipped_existing}${failNote} · ${result.duration_ms} ms`,
      });
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleExportCsv = async () => {
    if (!report || report.hits.length === 0) {
      setStatus({ tone: "err", text: "当前没有可导出的匹配结果" });
      return;
    }

    try {
      const destination = await save({
        title: "导出匹配清单",
        defaultPath: "photoflow_match_list.csv",
        filters: [{ name: "CSV 清单", extensions: ["csv"] }],
      });
      if (!destination) return;

      const rows = report.hits.map((pair) => ({
        core_num: pair.core_num,
        raw_name: pair.raw?.file_name ?? null,
        raw_path: pair.raw?.path ?? null,
        raw_size: pair.raw?.size ?? null,
        jpeg_name: pair.jpeg?.file_name ?? null,
        jpeg_path: pair.jpeg?.path ?? null,
        jpeg_size: pair.jpeg?.size ?? null,
      }));

      const count = await invoke<number>("write_match_csv", {
        destPath: destination,
        rows,
      });
      setStatus({ tone: "ok", text: `清单已导出 · ${count} 条 · ${destination}` });
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    }
  };

  const handleExport = async () => {
    if (rawFiles.length === 0) {
      setStatus({ tone: "err", text: "没有可导出预览的 RAW 文件" });
      return;
    }
    if (!exportDir.trim()) {
      setStatus({ tone: "err", text: "请先填写预览输出目录" });
      return;
    }

    setBusy("export");
    cancelRef.current = false;
    setProgress({ done: 0, total: rawFiles.length });
    let done = 0;
    let failed = 0;
    const failures: string[] = [];

    const maxBytes = settings.maxBytesKB > 0 ? settings.maxBytesKB * 1024 : null;

    for (const file of rawFiles) {
      if (cancelRef.current) break;

      const stem = file.file_name.replace(/\.[^.]+$/, "");
      const destination = joinPath(exportDir.trim(), `${stem}_preview.jpg`);
      try {
        await invoke<ExportOutcome>("quick_export_preview", {
          rawPath: file.path,
          destPath: destination,
          maxEdge: settings.maxEdge,
          quality: settings.quality,
          maxBytes,
        });
        done += 1;
      } catch (error) {
        failed += 1;
        failures.push(`${file.file_name}：${String(error)}`);
      }
      setProgress({ done: done + failed, total: rawFiles.length });
    }

    setProgress(null);
    setBusy(null);
    setFailures(failures);

    const cancelled = cancelRef.current;
    const limitNote = maxBytes ? ` · 单张上限 ${settings.maxBytesKB} KB` : "";
    const failNote = failed > 0 ? ` · 失败 ${failed}（${failures[0]}）` : "";
    setStatus({
      tone: failed > 0 ? "err" : cancelled ? "info" : "ok",
      text: `${cancelled ? "已停止" : "预览导出结束"} · 成功 ${done}${failNote} · 长边 ${settings.maxEdge}px · 质量 ${settings.quality}${limitNote}`,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-4 border-b border-white/5 px-6 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold tracking-tight text-zinc-100">快速找片</p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            粘贴任意文本 / 文件名 / 序列范围，毫秒级定位 RAW 与 JPG 配对
          </p>
        </div>

        <div className="flex w-[420px] items-center gap-2">
          <div className="relative flex-1">
            <FolderSearch
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600"
            />
            <input
              className="field pl-9 pr-9"
              placeholder="素材根目录，例如 D:\\2026_Shoot"
              value={sourceDir}
              onChange={(event) => setSourceDir(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleScan();
              }}
            />
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 transition hover:text-accent"
              title="选择素材根目录"
              onClick={() => void browseDirectory(sourceDir, setSourceDir, "选择素材根目录")}
            >
              <FolderOpen size={14} />
            </button>
          </div>
          <button
            type="button"
            className="btn-primary shrink-0"
            onClick={() => void handleScan()}
            disabled={scanning}
          >
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <ScanSearch size={14} />}
            {scanning ? "扫描中" : "建立索引"}
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 px-6 py-4">
        <section className="panel flex min-h-0 flex-col">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <ClipboardPaste size={14} className="text-accent" />
              <span className="text-[13px] font-medium text-zinc-200">查询文本</span>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" className="btn-muted px-2 py-1 text-[11px]" onClick={() => void handlePaste()}>
                <ClipboardPaste size={12} />
                粘贴
              </button>
              <button type="button" className="btn-muted px-2 py-1 text-[11px]" onClick={() => setQuery("")}>
                <Trash2 size={12} />
                清空
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col p-3">
            <textarea
              className="field min-h-0 flex-1 bg-ink-950/60 font-mono text-[13px] leading-6 text-zinc-200"
              placeholder={`支持任意混合内容，例如：\n\n_DSC8921.JPG\nIMG_1024\n1024-1035\nDSC01234.CR2`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              spellCheck={false}
            />
            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="chip">
                  <span className="text-zinc-600">hits</span>
                  <span className="text-zinc-300">{query.trim() ? report?.hits.length ?? 0 : 0}</span>
                </span>
                <span className="chip">
                  <span className="text-zinc-600">Ctrl+L</span>
                  <span className="text-zinc-300">清空</span>
                </span>
              </div>
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
                {matching ? (
                  <>
                    <Loader2 size={12} className="animate-spin text-accent" />
                    matching…
                  </>
                ) : (
                  <>
                    <span className={`dot ${report ? "bg-success" : "bg-zinc-600"}`} />
                    {report ? `${report.elapsed_ms} ms` : "idle"}
                  </>
                )}
              </span>
            </div>
          </div>
        </section>

        <section className="panel flex min-h-0 flex-col">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-success" />
              <span className="text-[13px] font-medium text-zinc-200">匹配监控</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-0.5 rounded-md border border-white/5 bg-ink-900/60 p-0.5">
                {(
                  [
                    { key: "both", label: "全部" },
                    { key: "raw", label: "仅 RAW" },
                    { key: "jpeg", label: "仅 JPG" },
                  ] as Array<{ key: PairMode; label: string }>
                ).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setPairMode(item.key)}
                    className={`rounded px-2 py-0.5 font-mono text-[10px] transition-colors ${
                      pairMode === item.key
                        ? "bg-accent/15 text-accent"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className="text-zinc-500">
                  RAW <span className="text-zinc-200">{report?.raw_hits ?? 0}</span>
                </span>
                <span className="text-zinc-700">/</span>
                <span className="text-zinc-500">
                  JPG <span className="text-zinc-200">{report?.jpeg_hits ?? 0}</span>
                </span>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
            {!scan && <EmptyState title="尚未建立索引" hint="填写素材根目录后点击「建立索引」" />}
            {scan && !query.trim() && (
              <EmptyState title="等待查询" hint="粘贴文件名、序号或序列范围即可自动匹配" />
            )}
            {scan && query.trim() && report && report.hits.length === 0 && (
              <EmptyState title="没有命中任何文件" hint="检查序号范围，或确认素材目录是否正确" />
            )}
            {report && report.hits.length > 0 && filteredHits.length === 0 && (
              <EmptyState title="当前筛选下没有结果" hint="切换到「全部」查看 RAW 与 JPG 的完整命中" />
            )}
            {filteredHits.length > 0 && (
              <div className="space-y-1.5">
                {filteredHits.map((pair, index) => (
                  <PairRow
                    key={`${pair.core_num ?? "x"}-${index}`}
                    pair={pair}
                    showThumbs={index < 80}
                    onLock={handleLockPair}
                  />
                ))}
              </div>
            )}
          </div>

          {report && report.failed_tokens.length > 0 && (
            <div className="border-t border-white/5 px-3 py-2">
              <div className="flex items-start gap-2">
                <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />
                <p className="line-clamp-2 font-mono text-[10px] text-zinc-500">
                  <span className="text-warn">未命中：</span>
                  {report.failed_tokens.join(" · ")}
                </p>
              </div>
            </div>
          )}
        </section>
      </div>

      <footer className="border-t border-white/5 bg-ink-950/60 px-6 py-3">
        {showParams && (
          <div className="mb-3 grid gap-3 rounded-lg border border-white/5 bg-ink-900/60 p-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="inline-max-edge">
                Max Edge
              </label>
              <select
                id="inline-max-edge"
                className="field py-1.5 text-[12px]"
                value={settings.maxEdge}
                onChange={(event) =>
                  onSettingsChange({ ...settings, maxEdge: Number(event.target.value) })
                }
                disabled={busy === "export"}
              >
                {[1200, 1600, 2048, 2560, 3200].map((edge) => (
                  <option key={edge} value={edge}>
                    {edge} px
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="inline-quality">
                Quality {settings.quality}
              </label>
              <input
                id="inline-quality"
                type="range"
                min={60}
                max={100}
                step={1}
                value={settings.quality}
                onChange={(event) =>
                  onSettingsChange({ ...settings, quality: Number(event.target.value) })
                }
                disabled={busy === "export"}
                className="mt-2 h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-600 accent-[#8257E5]"
              />
            </div>
            <div>
              <label className="label" htmlFor="inline-max-bytes">
                单张上限 (KB，0 不限)
              </label>
              <input
                id="inline-max-bytes"
                type="number"
                min={0}
                step={100}
                className="field py-1.5 text-[12px]"
                value={settings.maxBytesKB}
                onChange={(event) =>
                  onSettingsChange({
                    ...settings,
                    maxBytesKB: Math.max(0, Number(event.target.value) || 0),
                  })
                }
                disabled={busy === "export"}
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className="chip">
              <span className="text-zinc-600">hits</span>
              <span className="text-success">{report?.hit_count ?? 0}</span>
            </span>
            <span className="chip">
              <span className="text-zinc-600">miss</span>
              <span className={report?.failed_tokens.length ? "text-warn" : "text-zinc-400"}>
                {report?.failed_tokens.length ?? 0}
              </span>
            </span>
            {scan && (
              <span className="chip">
                <span className="text-zinc-600">library</span>
                <span className="text-zinc-300">{scan.total.toLocaleString()}</span>
              </span>
            )}
          </div>

          <div className="flex flex-1 items-center justify-end gap-2">
            <div className="relative w-[190px]">
              <input
                className="field py-1.5 pr-8 text-[12px]"
                placeholder="归档目录 D:\\Archive"
                value={archiveDir}
                onChange={(event) => onArchiveDirChange(event.target.value)}
              />
              <button
                type="button"
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 transition hover:text-accent"
                title="选择归档目录"
                onClick={() =>
                  void browseDirectory(archiveDir, onArchiveDirChange, "选择归档目录")
                }
              >
                <FolderOpen size={12} />
              </button>
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void handleCopy()}
              disabled={busy !== null || matchedPaths.length === 0}
            >
              {busy === "copy" ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
              仅复制匹配项
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void handleExportCsv()}
              disabled={busy !== null || !report || report.hits.length === 0}
              title="把当前匹配结果导出为 CSV 清单"
            >
              <FileSpreadsheet size={14} />
              导出清单
            </button>
            <div className="relative w-[190px]">
              <input
                className="field py-1.5 pr-8 text-[12px]"
                placeholder="预览输出 D:\\Preview"
                value={exportDir}
                onChange={(event) => onExportDirChange(event.target.value)}
              />
              <button
                type="button"
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 transition hover:text-accent"
                title="选择预览输出目录"
                onClick={() =>
                  void browseDirectory(exportDir, onExportDirChange, "选择预览输出目录")
                }
              >
                <FolderOpen size={12} />
              </button>
            </div>
            <button
              type="button"
              className={`btn-muted ${showParams ? "text-accent" : ""}`}
              onClick={() => setShowParams((value) => !value)}
              title="就地调整导出参数"
            >
              <Settings2 size={14} />
              参数
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleExport()}
              disabled={busy !== null || rawFiles.length === 0}
            >
              {busy === "export" ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />}
              {progress ? `导出 ${progress.done}/${progress.total}` : "极速导出内嵌预览"}
            </button>
            {busy === "export" && (
              <button
                type="button"
                className="btn-muted"
                onClick={() => {
                  cancelRef.current = true;
                  setStatus({ tone: "info", text: "正在停止导出…" });
                }}
              >
                <X size={14} />
                停止
              </button>
            )}
          </div>
        </div>

        {status && (
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`dot ${
                status.tone === "ok" ? "bg-success" : status.tone === "err" ? "bg-danger" : "bg-zinc-500"
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

        {failures.length > 0 && (
          <div className="mt-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2">
            <p className="font-mono text-[10px] text-danger">
              导出失败 {failures.length} 项{failures.length > 3 ? "（仅显示前 3 项）" : ""}
            </p>
            <ul className="mt-1 space-y-0.5">
              {failures.slice(0, 3).map((item) => (
                <li key={item} className="truncate font-mono text-[10px] text-zinc-500">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </footer>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <FileImage size={22} className="text-zinc-700" />
      <p className="text-[12px] text-zinc-500">{title}</p>
      <p className="text-[11px] text-zinc-700">{hint}</p>
    </div>
  );
}

function PairRow({
  pair,
  showThumbs,
  onLock,
}: {
  pair: MatchPair;
  showThumbs: boolean;
  onLock: (pair: MatchPair) => void;
}) {
  const paired = Boolean(pair.raw && pair.jpeg);
  return (
    <div className="rounded-lg border border-white/5 bg-ink-900/60 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-mono text-[11px] text-accent">
          {pair.core_num !== null ? `#${pair.core_num}` : "no-seq"}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-1 rounded border border-white/5 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 transition-colors hover:border-accent/30 hover:text-accent"
            title="锁定这一对，显式反查另一半（JPG → RAW / RAW → JPG）"
            onClick={() => onLock(pair)}
          >
            <ArrowLeftRight size={10} />
            锁定这对
          </button>
          <span
            className={`font-mono text-[10px] ${
              paired ? "text-success" : "text-zinc-500"
            }`}
          >
            {paired ? "PAIRED" : pair.raw ? "RAW ONLY" : "JPG ONLY"}
          </span>
        </div>
      </div>
      <div className="space-y-1">
        <FileLine file={pair.raw} tone="raw" showThumb={showThumbs} />
        <FileLine file={pair.jpeg} tone="jpeg" showThumb={showThumbs} />
      </div>
    </div>
  );
}

function Thumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);

    invoke<string>("thumbnail_data_url", { path, maxEdge: 112 })
      .then((value) => {
        if (!cancelled) setSrc(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  if (failed) {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-white/5 bg-ink-800">
        <FileImage size={13} className="text-zinc-700" />
      </div>
    );
  }

  return (
    <div className="h-9 w-9 shrink-0 overflow-hidden rounded border border-white/5 bg-ink-800">
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Loader2 size={12} className="animate-spin text-zinc-700" />
        </div>
      )}
    </div>
  );
}

function FileLine({
  file,
  tone,
  showThumb,
}: {
  file: MatchPair["raw"];
  tone: "raw" | "jpeg";
  showThumb: boolean;
}) {
  if (!file) {
    return (
      <div className="flex items-center gap-2 opacity-40">
        {showThumb && <div className="h-9 w-9 shrink-0 rounded border border-dashed border-white/10" />}
        <span className="dot bg-zinc-700" />
        <span className="font-mono text-[10px] text-zinc-600">
          {tone === "raw" ? "RAW 未找到" : "JPG 未找到"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {showThumb && <Thumb path={file.path} />}
      <span className={`dot ${tone === "raw" ? "bg-accent" : "bg-success"}`} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300" title={file.path}>
        {file.file_name}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-zinc-600">{formatBytes(file.size)}</span>
    </div>
  );
}

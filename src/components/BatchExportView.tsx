import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FileImage,
  FolderOpen,
  FolderSearch,
  ImageDown,
  Image as ImageIcon,
  Loader2,
  ScanSearch,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppSettings, ExportOutcome, MatchedFile } from "../types";

interface BatchExportViewProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  exportDir: string;
  onExportDirChange: (value: string) => void;
}

type Tone = "ok" | "err" | "info";

interface StatusMessage {
  tone: Tone;
  text: string;
}

const edgeOptions = [1200, 1600, 2048, 2560, 3200];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
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

export default function BatchExportView({
  settings,
  onSettingsChange,
  exportDir,
  onExportDirChange,
}: BatchExportViewProps) {
  const [sourceDir, setSourceDir] = useState("");
  const [files, setFiles] = useState<MatchedFile[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 6000);
    return () => clearTimeout(timer);
  }, [status]);

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

  const handleScan = async () => {
    if (!sourceDir.trim()) {
      setStatus({ tone: "err", text: "请先填写素材根目录" });
      return;
    }
    setScanning(true);
    setStatus(null);
    try {
      const result = await invoke<MatchedFile[]>("scan_export_sources", {
        rootDir: sourceDir.trim(),
      });
      setFiles(result);
      setStatus({
        tone: "ok",
        text: `可导出素材 ${result.length.toLocaleString()} 个（RAW + HEIC/HEIF）`,
      });
    } catch (error) {
      setFiles(null);
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setScanning(false);
    }
  };

  const handleExport = async () => {
    if (!files || files.length === 0) {
      setStatus({ tone: "err", text: "没有可导出的素材" });
      return;
    }
    if (!exportDir.trim()) {
      setStatus({ tone: "err", text: "请先填写预览输出目录" });
      return;
    }

    setExporting(true);
    cancelRef.current = false;
    setFailures([]);
    setProgress({ done: 0, total: files.length });

    const maxBytes = settings.maxBytesKB > 0 ? settings.maxBytesKB * 1024 : null;
    let done = 0;
    const failed: string[] = [];

    for (const file of files) {
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
        failed.push(`${file.file_name}：${String(error)}`);
      }
      setProgress({ done: done + failed.length, total: files.length });
    }

    setProgress(null);
    setExporting(false);
    setFailures(failed);

    const cancelled = cancelRef.current;
    const limitNote = maxBytes ? ` · 单张上限 ${settings.maxBytesKB} KB` : "";
    const failNote = failed.length > 0 ? ` · 失败 ${failed.length}（${failed[0]}）` : "";
    setStatus({
      tone: failed.length > 0 ? "err" : cancelled ? "info" : "ok",
      text: `${cancelled ? "已停止" : "预览导出结束"} · 成功 ${done}${failNote} · 长边 ${settings.maxEdge}px · 质量 ${settings.quality}${limitNote}`,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-4 border-b border-white/5 px-6 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold tracking-tight text-zinc-100">批量导出</p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            整目录抽取内嵌预览 · RAW / HEIC 直达 JPEG，跳过反马赛克
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
              onClick={() => void pickDirectory(sourceDir, setSourceDir, "选择素材根目录")}
            >
              <FolderOpen size={14} />
            </button>
          </div>
          <button
            type="button"
            className="btn-primary shrink-0"
            onClick={() => void handleScan()}
            disabled={scanning || exporting}
          >
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <ScanSearch size={14} />}
            {scanning ? "扫描中" : "扫描素材"}
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 px-6 py-4 lg:grid-cols-[1.35fr_1fr]">
        <section className="panel flex min-h-0 flex-col">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <ImageIcon size={14} className="text-accent" />
              <span className="text-[13px] font-medium text-zinc-200">待导出素材</span>
            </div>
            <span className="font-mono text-[11px] text-zinc-500">
              {files ? `${files.length.toLocaleString()} files` : "idle"}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
            {!files && (
              <EmptyState title="尚未扫描素材" hint="填写素材根目录后点击「扫描素材」" />
            )}
            {files && files.length === 0 && (
              <EmptyState title="没有可导出的素材" hint="该目录下未找到 RAW 或 HEIC/HEIF 文件" />
            )}
            {files && files.length > 0 && (
              <div className="space-y-1">
                {files.map((file) => (
                  <div
                    key={file.path}
                    className="flex items-center gap-2 rounded-md border border-white/5 bg-ink-900/60 px-3 py-1.5"
                  >
                    <span className="dot bg-accent" />
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300"
                      title={file.path}
                    >
                      {file.file_name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                      {file.capture_date}
                    </span>
                    <span className="w-16 shrink-0 text-right font-mono text-[10px] text-zinc-600">
                      {formatBytes(file.size)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="panel flex min-h-0 flex-col">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <ImageDown size={14} className="text-success" />
              <span className="text-[13px] font-medium text-zinc-200">导出参数</span>
            </div>
            <span className="font-mono text-[10px] text-zinc-600">就地可调</span>
          </div>

          <div className="space-y-4 p-4">
            <div>
              <label className="label" htmlFor="export-max-edge">
                Max Edge (px)
              </label>
              <select
                id="export-max-edge"
                className="field"
                value={settings.maxEdge}
                onChange={(event) =>
                  onSettingsChange({ ...settings, maxEdge: Number(event.target.value) })
                }
                disabled={exporting}
              >
                {edgeOptions.map((edge) => (
                  <option key={edge} value={edge}>
                    {edge} px
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="export-quality">
                JPEG Quality
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="export-quality"
                  type="range"
                  min={60}
                  max={100}
                  step={1}
                  value={settings.quality}
                  onChange={(event) =>
                    onSettingsChange({ ...settings, quality: Number(event.target.value) })
                  }
                  disabled={exporting}
                  className="h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-600 accent-[#8257E5]"
                />
                <span className="w-10 shrink-0 text-right font-mono text-[12px] text-zinc-300">
                  {settings.quality}
                </span>
              </div>
            </div>

            <div>
              <label className="label" htmlFor="export-max-bytes">
                单张体积上限 (KB)
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="export-max-bytes"
                  type="number"
                  min={0}
                  step={100}
                  className="field"
                  value={settings.maxBytesKB}
                  onChange={(event) =>
                    onSettingsChange({
                      ...settings,
                      maxBytesKB: Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                  disabled={exporting}
                />
                <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                  {settings.maxBytesKB > 0 ? `${(settings.maxBytesKB / 1024).toFixed(1)} MB` : "不限"}
                </span>
              </div>
            </div>

            <div>
              <label className="label" htmlFor="export-dest">
                预览输出目录
              </label>
              <div className="relative">
                <input
                  id="export-dest"
                  className="field pr-9"
                  placeholder="D:\\Preview"
                  value={exportDir}
                  onChange={(event) => onExportDirChange(event.target.value)}
                  disabled={exporting}
                />
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 transition hover:text-accent"
                  title="选择预览输出目录"
                  onClick={() => void pickDirectory(exportDir, onExportDirChange, "选择预览输出目录")}
                >
                  <FolderOpen size={14} />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-primary flex-1 justify-center"
                onClick={() => void handleExport()}
                disabled={exporting || scanning || !files || files.length === 0}
              >
                {exporting ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />}
                {progress ? `导出 ${progress.done}/${progress.total}` : "开始批量导出"}
              </button>
              {exporting && (
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
              </div>
            )}

            {progress && (
              <div className="h-1 w-full overflow-hidden rounded-full bg-ink-700">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
            )}

            {failures.length > 0 && (
              <div className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2">
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
          </div>
        </section>
      </div>
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

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileSpreadsheet,
  FolderOpen,
  ImageDown,
  Layers,
  Loader2,
  RotateCcw,
  RotateCw,
  ScanSearch,
  Star,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { groupBursts } from "../lib/burst";
import type {
  AppSettings,
  ArchiveReport,
  CullItem,
  CullScanReport,
  ExportOutcome,
  RatingReport,
} from "../types";

type Mark = "keep" | "cull";
type Filter = "all" | "keep" | "cull" | "unmarked";

interface CullViewProps {
  settings: AppSettings;
}

interface StatusMessage {
  tone: "ok" | "err" | "info";
  text: string;
}

function joinPath(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const separator = trimmed.includes("\\") ? "\\" : "/";
  return `${trimmed}${separator}${name}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** epoch 按 UTC 解释（与后端一致），避免时区偏移导致连拍间隔误判。 */
function clockLabel(epoch: number): string {
  if (!epoch) return "--:--:--";
  const date = new Date(epoch * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

const thumbCache = new Map<string, string>();

/// 跨页面切换保留挑片进度（切到全局设置再回来不会丢数据）。
const cullSession = {
  dir: "",
  items: [] as CullItem[],
  marks: {} as Record<string, Mark>,
  rotations: {} as Record<string, number>,
  cursor: 0,
  gap: 2,
  filter: "all" as Filter,
  dateFilter: "all",
};

/// 拍摄日期键：优先 EXIF 日期，缺失时归入「未知日期」。
function dateKey(item: CullItem): string {
  const value = (item.capture_date ?? "").trim().slice(0, 10);
  return value || "未知日期";
}

function KeyHint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className="rounded border border-white/10 bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
        {keys}
      </kbd>
      <span>{label}</span>
    </span>
  );
}

function GroupThumb({
  item,
  active,
  mark,
  rotation,
  onClick,
}: {
  item: CullItem;
  active: boolean;
  mark?: Mark;
  rotation: number;
  onClick: () => void;
}) {
  const key = `${item.path}#${rotation}`;
  const [src, setSrc] = useState<string | null>(thumbCache.get(key) ?? null);

  useEffect(() => {
    const cached = thumbCache.get(key);
    if (cached) {
      setSrc(cached);
      return;
    }
    let alive = true;
    void invoke<string>("thumbnail_data_url", {
      path: item.path,
      maxEdge: 160,
      rotation,
    })
      .then((data) => {
        thumbCache.set(key, data);
        if (alive) setSrc(data);
      })
      .catch(() => {
        /* 缩略图失败时保留占位 */
      });
    return () => {
      alive = false;
    };
  }, [item.path, rotation, key]);

  return (
    <button
      type="button"
      title={`${item.file_name} · ${clockLabel(item.epoch)}`}
      onClick={onClick}
      className={`relative aspect-square overflow-hidden rounded-md border ${
        active
          ? "border-accent"
          : mark === "keep"
            ? "border-success/50"
            : mark === "cull"
              ? "border-danger/50"
              : "border-white/10"
      }`}
    >
      {src ? (
        <img src={src} alt={item.file_name} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center bg-ink-800 font-mono text-[9px] text-zinc-600">
          JPG
        </span>
      )}
      {mark && (
        <span
          className={`absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ${
            mark === "keep" ? "bg-success" : "bg-danger"
          }`}
        />
      )}
    </button>
  );
}

export default function CullView({ settings }: CullViewProps) {
  const [dir, setDir] = useState(cullSession.dir);
  const [items, setItems] = useState<CullItem[]>(cullSession.items);
  const [dateFilter, setDateFilter] = useState(cullSession.dateFilter);
  const [marks, setMarks] = useState<Record<string, Mark>>(cullSession.marks);
  const [rotations, setRotations] = useState<Record<string, number>>(cullSession.rotations);
  const [cursor, setCursor] = useState(cullSession.cursor);
  const [gap, setGap] = useState(cullSession.gap);
  const [filter, setFilter] = useState<Filter>(cullSession.filter);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [actual, setActual] = useState(false);
  const [fullPreview, setFullPreview] = useState<string | null>(null);
  const [fullLoading, setFullLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [writingRatings, setWritingRatings] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);

  useEffect(() => {
    Object.assign(cullSession, {
      dir,
      items,
      marks,
      rotations,
      cursor,
      gap,
      filter,
      dateFilter,
    });
  }, [dir, items, marks, rotations, cursor, gap, filter, dateFilter]);
  const cancelRef = useRef(false);
  const previewCache = useRef<Map<string, string>>(new Map());
  const fullCache = useRef<Map<string, string>>(new Map());

  const dates = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) {
      const key = dateKey(item);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((left, right) =>
      right[0].localeCompare(left[0])
    );
  }, [items]);

  const dayItems = useMemo(
    () =>
      dateFilter === "all"
        ? items
        : items.filter((item) => dateKey(item) === dateFilter),
    [items, dateFilter]
  );

  const groupRanges = useMemo(() => {
    return groupBursts(dayItems.map((item) => item.epoch), gap);
  }, [dayItems, gap]);

  const visible = useMemo(() => {
    const list = dayItems.map((_, index) => index);
    if (filter === "all") return list;
    return list.filter((index) => {
      const mark = marks[dayItems[index].path];
      if (filter === "unmarked") return !mark;
      return mark === filter;
    });
  }, [dayItems, marks, filter]);

  const currentIndex = visible.length > 0 ? visible[Math.min(cursor, visible.length - 1)] : -1;
  const current = currentIndex >= 0 ? dayItems[currentIndex] : null;
  const currentRotation = current ? rotations[current.path] ?? 0 : 0;
  const previewKey = current ? `${current.path}#${currentRotation}` : "";

  const currentGroup = useMemo(() => {
    if (currentIndex < 0) return null;
    const range = groupRanges.find(
      (item) => currentIndex >= item.start && currentIndex < item.end
    );
    return range ?? null;
  }, [groupRanges, currentIndex]);

  const counts = useMemo(() => {
    let keep = 0;
    let cull = 0;
    for (const item of dayItems) {
      const mark = marks[item.path];
      if (mark === "keep") keep += 1;
      else if (mark === "cull") cull += 1;
    }
    return { keep, cull, unmarked: dayItems.length - keep - cull };
  }, [dayItems, marks]);

  useEffect(() => {
    setCursor(0);
  }, [dateFilter]);

  useEffect(() => {
    if (visible.length === 0) {
      if (cursor !== 0) setCursor(0);
      return;
    }
    if (cursor > visible.length - 1) setCursor(visible.length - 1);
  }, [visible.length, cursor]);

  useEffect(() => {
    if (!current) {
      setPreview(null);
      setActual(false);
      setFullPreview(null);
      return;
    }
    setActual(false);
    setFullPreview(null);
    const cached = previewCache.current.get(previewKey);
    if (cached) {
      setPreview(cached);
      return;
    }
    let active = true;
    setPreviewLoading(true);
    void (async () => {
      try {
        const data = await invoke<string>("thumbnail_data_url", {
          path: current.path,
          maxEdge: 1400,
          rotation: currentRotation,
        });
        previewCache.current.set(previewKey, data);
        if (active) setPreview(data);
      } catch (error) {
        if (active) setStatus({ tone: "err", text: String(error) });
      } finally {
        if (active) setPreviewLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [previewKey]);

  const loadActual = async () => {
    if (!current) return;
    setActual(true);
    const cached = fullCache.current.get(previewKey);
    if (cached) {
      setFullPreview(cached);
      return;
    }
    setFullLoading(true);
    setStatus({ tone: "info", text: `加载原分辨率预览：${current.file_name}` });
    try {
      const data = await invoke<string>("focus_preview_data_url", {
        path: current.path,
        rotation: currentRotation,
      });
      fullCache.current.set(previewKey, data);
      setFullPreview(data);
      setStatus(null);
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
      setActual(false);
    } finally {
      setFullLoading(false);
    }
  };

  const rotate = (delta: 1 | -1) => {
    if (!current) return;
    const path = current.path;
    setRotations((previous) => ({
      ...previous,
      [path]: ((((previous[path] ?? 0) + delta) % 4) + 4) % 4,
    }));
    setActual(false);
    setFullPreview(null);
  };

  const panRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const draggedRef = useRef(false);
  const [panning, setPanning] = useState(false);

  const handlePanStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = panRef.current;
    if (!element) return;
    dragState.current = {
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop,
    };
    draggedRef.current = false;
    setPanning(true);
    element.setPointerCapture(event.pointerId);
  };

  const handlePanMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = panRef.current;
    const start = dragState.current;
    if (!element || !start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) draggedRef.current = true;
    element.scrollLeft = start.left - dx;
    element.scrollTop = start.top - dy;
  };

  const handlePanEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = panRef.current;
    if (element && element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    dragState.current = null;
    setPanning(false);
  };

  const toggleZoom = () => {
    if (actual) {
      setActual(false);
      return;
    }
    void loadActual();
  };

  const move = (delta: number) => {
    if (visible.length === 0) return;
    setCursor((value) => Math.min(Math.max(value + delta, 0), visible.length - 1));
  };

  const jumpGroup = (direction: 1 | -1) => {
    if (!currentGroup) return;
    const targetGroup =
      direction === 1
        ? groupRanges[groupRanges.indexOf(currentGroup) + 1]
        : groupRanges[groupRanges.indexOf(currentGroup) - 1];
    if (!targetGroup) return;
    const position = visible.findIndex((index) => index >= targetGroup.start);
    if (position >= 0) setCursor(position);
  };

  const setMark = (mark: Mark | null) => {
    if (!current) return;
    setMarks((previous) => {
      const next = { ...previous };
      if (mark === null) delete next[current.path];
      else next[current.path] = mark;
      return next;
    });
    if (filter !== "all" && filter !== "unmarked" && mark !== filter) {
      // 在筛选视图里打反标记时保持在原位置，由 visible 自动剔除。
      setCursor((value) => Math.max(0, Math.min(value, visible.length - 2)));
      return;
    }
    move(1);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      const key = event.key.toLowerCase();
      if (key === "arrowright" || key === "arrowdown") {
        event.preventDefault();
        if (event.shiftKey) jumpGroup(1);
        else move(1);
      } else if (key === "arrowleft" || key === "arrowup") {
        event.preventDefault();
        if (event.shiftKey) jumpGroup(-1);
        else move(-1);
      } else if (key === "p") {
        event.preventDefault();
        setMark("keep");
      } else if (key === "x") {
        event.preventDefault();
        setMark("cull");
      } else if (key === "u") {
        event.preventDefault();
        setMark(null);
      } else if (key === "z") {
        event.preventDefault();
        toggleZoom();
      } else if (key === "[" || key === "]") {
        event.preventDefault();
        rotate(key === "]" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const browseDir = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择拍摄目录（JPG）",
        defaultPath: dir.trim() || undefined,
      });
      if (typeof selected === "string" && selected.trim()) {
        setDir(selected);
        void handleScan(selected);
      }
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    }
  };

  const handleScan = async (targetDir?: string) => {
    const target = (targetDir ?? dir).trim();
    if (!target) {
      setStatus({ tone: "err", text: "请先选择拍摄目录" });
      return;
    }
    if (targetDir) setDir(target);
    setLoading(true);
    setStatus(null);
    try {
      const report = await invoke<CullScanReport>("cull_list", { rootDir: target });
      setItems(report.items);
      const preloaded: Record<string, Mark> = {};
      for (const item of report.items) {
        if ((item.rating ?? 0) > 0) preloaded[item.path] = "keep";
      }
      setMarks(preloaded);
      setCursor(0);
      setDateFilter("all");
      setRotations({});
      previewCache.current.clear();
      fullCache.current.clear();
      const withRating = Object.keys(preloaded).length;
      const dayCount = new Set(report.items.map((item) => dateKey(item))).size;
      const skippedNote =
        report.skipped > 0 ? ` · 跳过 ${report.skipped} 个非 JPG 文件` : "";
      if (report.items.length === 0) {
        setStatus({
          tone: "err",
          text: `该目录共 ${report.total_files} 个文件，没有可挑片的 JPG（支持 jpg / jpeg / heic / heif）`,
        });
      } else {
        setStatus({
          tone: "ok",
          text: `已载入 ${report.items.length} 张照片（含子目录共 ${report.total_files} 个文件${skippedNote}）· ${dayCount} 个拍摄日期${
            withRating > 0 ? ` · 相机星标 ${withRating} 张已预置为保留` : ""
          }`,
        });
      }
    } catch (error) {
      setItems([]);
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setLoading(false);
    }
  };

  const keptItems = useMemo(
    () => dayItems.filter((item) => marks[item.path] === "keep"),
    [dayItems, marks]
  );

  const handleExportKept = async () => {
    if (keptItems.length === 0) {
      setStatus({ tone: "err", text: "还没有标记为保留的照片（按 P 保留）" });
      return;
    }
    try {
      const destination = await open({
        directory: true,
        multiple: false,
        title: "选择交付目录",
        defaultPath: dir.trim() || undefined,
      });
      if (typeof destination !== "string" || !destination.trim()) return;
      const normalizedSource = dir.trim().replace(/[\\/]+$/, "").toLowerCase();
      if (destination.replace(/[\\/]+$/, "").toLowerCase() === normalizedSource) {
        setStatus({ tone: "err", text: "交付目录不能与拍摄目录相同，否则会覆盖原片" });
        return;
      }

      setExporting(true);
      cancelRef.current = false;
      setProgress({ done: 0, total: keptItems.length });
      let done = 0;
      let failed = 0;
      const failures: string[] = [];
      const maxBytes = settings.maxBytesKB > 0 ? settings.maxBytesKB * 1024 : null;

      for (const item of keptItems) {
        if (cancelRef.current) break;
        try {
          await invoke<ExportOutcome>("quick_export_preview", {
            rawPath: item.path,
            destPath: joinPath(destination.trim(), item.file_name),
            maxEdge: settings.maxEdge,
            quality: settings.quality,
            maxBytes,
          });
          done += 1;
        } catch (error) {
          failed += 1;
          failures.push(`${item.file_name}：${String(error)}`);
        }
        setProgress({ done: done + failed, total: keptItems.length });
      }

      setProgress(null);
      setExporting(false);
      const cancelled = cancelRef.current;
      setStatus({
        tone: failed > 0 ? "err" : "ok",
        text: `${cancelled ? "已停止" : "交付导出完成"} · 成功 ${done} · 失败 ${failed}${
          failures.length > 0 ? ` · ${failures[0]}` : ""
        }`,
      });
    } catch (error) {
      setExporting(false);
      setProgress(null);
      setStatus({ tone: "err", text: String(error) });
    }
  };

  const handleCopyKept = async () => {
    if (keptItems.length === 0) {
      setStatus({ tone: "err", text: "还没有标记为保留的照片（按 P 保留）" });
      return;
    }
    try {
      const destination = await open({
        directory: true,
        multiple: false,
        title: "选择交付目录（复制保留原片）",
        defaultPath: dir.trim() || undefined,
      });
      if (typeof destination !== "string" || !destination.trim()) return;

      const normalizedSource = dir.trim().replace(/[\\/]+$/, "").toLowerCase();
      if (destination.replace(/[\\/]+$/, "").toLowerCase() === normalizedSource) {
        setStatus({ tone: "err", text: "交付目录不能与拍摄目录相同" });
        return;
      }

      setCopying(true);
      const report = await invoke<ArchiveReport>("copy_cull_kept", {
        paths: keptItems.map((item) => item.path),
        destDir: destination.trim(),
      });
      setStatus({
        tone: report.failed.length > 0 ? "err" : "ok",
        text: `原片复制完成 · 新增 ${report.copied} · 已存在跳过 ${report.skipped_existing}${
          report.failed.length > 0 ? ` · 失败 ${report.failed.length}：${report.failed[0]}` : ""
        } · ${report.duration_ms} ms`,
      });
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setCopying(false);
    }
  };

  const handleExportCsv = async () => {
    if (dayItems.length === 0) {
      setStatus({ tone: "err", text: "当前没有可导出的文件" });
      return;
    }
    try {
      const destination = await save({
        title: "导出挑片清单",
        defaultPath: "photoflow_cull_list.csv",
        filters: [{ name: "CSV 清单", extensions: ["csv"] }],
      });
      if (!destination) return;

      const rows = dayItems.map((item) => ({
        file_name: item.file_name,
        path: item.path,
        capture_date: item.capture_date,
        mark: marks[item.path] === "keep"
          ? "KEEP"
          : marks[item.path] === "cull"
            ? "CULL"
            : "UNMARKED",
        size: item.size,
      }));

      const count = await invoke<number>("write_cull_csv", { destPath: destination, rows });
      setStatus({ tone: "ok", text: `清单已导出 · ${count} 条 · ${destination}` });
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    }
  };

  const handleWriteRatings = async () => {
    const rows: Array<{ path: string; rating: number }> = [];
    for (const item of dayItems) {
      const mark = marks[item.path];
      if (mark === "keep") rows.push({ path: item.path, rating: 3 });
      else if (mark === "cull") rows.push({ path: item.path, rating: 0 });
    }
    if (rows.length === 0) {
      setStatus({ tone: "err", text: "还没有任何标记，先按 P 保留或 X 淘汰" });
      return;
    }

    const keepCount = rows.filter((row) => row.rating === 3).length;
    const cullCount = rows.length - keepCount;
    if (
      !window.confirm(
        `将把 ${keepCount} 张写为 3 星、${cullCount} 张写为 0 星（清除），直接修改 JPG 元数据。是否继续？`
      )
    ) {
      return;
    }

    setWritingRatings(true);
    try {
      const report = await invoke<RatingReport>("apply_cull_ratings", { rows });
      setItems((previous) =>
        previous.map((item) => {
          const mark = marks[item.path];
          if (mark === "keep") return { ...item, rating: 3 };
          if (mark === "cull") return { ...item, rating: null };
          return item;
        })
      );
      setStatus({
        tone: report.failed.length > 0 ? "err" : "ok",
        text: `星标写回完成 · ${report.written} 个文件${
          report.cleared > 0 ? `（清除 ${report.cleared}）` : ""
        }${report.failed.length > 0 ? ` · 失败 ${report.failed.length}：${report.failed[0]}` : ""} · ${
          report.duration_ms
        } ms`,
      });
    } catch (error) {
      setStatus({ tone: "err", text: String(error) });
    } finally {
      setWritingRatings(false);
    }
  };

  const filters: Array<{ key: Filter; label: string; count: number }> = [
    { key: "all", label: "全部", count: dayItems.length },
    { key: "keep", label: "保留", count: counts.keep },
    { key: "cull", label: "淘汰", count: counts.cull },
    { key: "unmarked", label: "未标记", count: counts.unmarked },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="space-y-3 border-b border-white/5 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[15px] font-semibold tracking-tight text-zinc-100">连拍挑片</p>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              按拍摄时间自动分组 · 打完标记自动跳下一张 · 佳能 / 索尼请分目录载入
            </p>
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className="rounded-md border border-success/30 px-2 py-1 text-success">
              保留 {counts.keep}
            </span>
            <span className="rounded-md border border-danger/30 px-2 py-1 text-danger">
              淘汰 {counts.cull}
            </span>
            <span className="rounded-md border border-white/10 px-2 py-1 text-zinc-500">
              未标记 {counts.unmarked}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            className="field min-w-[240px] flex-1"
            placeholder="拍摄目录（JPG 所在文件夹）"
            value={dir}
            onChange={(event) => setDir(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleScan();
            }}
          />
          <button type="button" className="btn-muted" onClick={() => void browseDir()}>
            <FolderOpen size={14} />
            浏览
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleScan()}
            disabled={loading}
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <ScanSearch size={14} />}
            {loading ? "载入中" : "载入照片"}
          </button>

          <label
            className="ml-2 flex items-center gap-1.5 text-[11px] text-zinc-500"
            title="足球 / 篮球建议 2 秒，田径 1 秒；调大间隔会把相邻连拍合并成一组"
          >
            <Layers size={13} className="text-zinc-500" />
            连拍间隔
            <select
              className="rounded-md border border-white/10 bg-ink-800 px-1.5 py-1 font-mono text-[11px] text-zinc-300"
              value={gap}
              onChange={(event) => setGap(Number(event.target.value))}
            >
              {[1, 2, 3, 5, 10].map((value) => (
                <option key={value} value={value}>
                  {value}s
                </option>
              ))}
            </select>
          </label>

          <label
            className="flex items-center gap-1.5 text-[11px] text-zinc-500"
            title="按 EXIF 拍摄日期筛选，只挑某一天的照片；无 EXIF 时按文件修改日期归入「未知日期」"
          >
            <CalendarDays size={13} className="text-zinc-500" />
            拍摄日期
            <select
              className="max-w-[210px] rounded-md border border-white/10 bg-ink-800 px-1.5 py-1 font-mono text-[11px] text-zinc-300"
              value={dateFilter}
              onChange={(event) => setDateFilter(event.target.value)}
            >
              <option value="all">全部日期（{items.length} 张）</option>
              {dates.map(([date, count]) => (
                <option key={date} value={date}>
                  {date}（{count} 张）
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-zinc-600">
          <KeyHint keys="P" label="保留" />
          <KeyHint keys="X" label="淘汰" />
          <KeyHint keys="U" label="清除标记" />
          <KeyHint keys="← →" label="逐张翻阅" />
          <KeyHint keys="Shift + ← →" label="整组跳转" />
          <KeyHint keys="Z" label="100% 焦点" />
          <KeyHint keys="[ ]" label="旋转 90°" />
          <span className="text-zinc-700">|</span>
          <span>标记后自动前进；筛选视图下标记会移出当前列表</span>
        </div>

        {status && (
          <p
            className={`text-[11px] ${
              status.tone === "err"
                ? "text-danger"
                : status.tone === "ok"
                  ? "text-success"
                  : "text-zinc-400"
            }`}
          >
            {status.text}
          </p>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="relative flex min-h-0 min-w-0 flex-1 bg-ink-950/60">
          <div className="absolute right-3 top-3 z-10 flex items-center gap-1">
            <button
              type="button"
              className="rounded-md border border-white/10 bg-ink-800 px-2 py-1 text-zinc-400 transition-colors hover:text-zinc-200"
              onClick={() => rotate(-1)}
              title="向左旋转 90°（[）"
            >
              <RotateCcw size={12} />
            </button>
            <button
              type="button"
              className="rounded-md border border-white/10 bg-ink-800 px-2 py-1 text-zinc-400 transition-colors hover:text-zinc-200"
              onClick={() => rotate(1)}
              title="向右旋转 90°（]）"
            >
              <RotateCw size={12} />
            </button>
            {currentRotation > 0 && (
              <span className="rounded-md border border-white/10 bg-ink-800 px-2 py-1 font-mono text-[10px] text-warn">
                {currentRotation * 90}°
              </span>
            )}
            <button
              type="button"
              className={`rounded-md border px-2 py-1 font-mono text-[10px] transition-colors ${
                actual
                  ? "border-white/10 bg-ink-800 text-zinc-400 hover:text-zinc-200"
                  : "border-accent/30 bg-accent/10 text-accent"
              }`}
              onClick={() => setActual(false)}
              title="缩放到适合窗口"
            >
              适应
            </button>
            <button
              type="button"
              className={`rounded-md border px-2 py-1 font-mono text-[10px] transition-colors ${
                actual
                  ? "border-accent/30 bg-accent/10 text-accent"
                  : "border-white/10 bg-ink-800 text-zinc-400 hover:text-zinc-200"
              }`}
              onClick={() => void loadActual()}
              title="原分辨率 100%，用于检查是否对上焦"
            >
              100%
            </button>
          </div>

          {actual ? (
            <div
              ref={panRef}
              className={`flex min-h-0 flex-1 items-center justify-center overflow-auto select-none ${
                panning ? "cursor-grabbing" : "cursor-grab"
              }`}
              onPointerDown={handlePanStart}
              onPointerMove={handlePanMove}
              onPointerUp={handlePanEnd}
              onPointerCancel={handlePanEnd}
              onClick={() => {
                if (draggedRef.current) {
                  draggedRef.current = false;
                  return;
                }
                toggleZoom();
              }}
            >
              {fullLoading ? (
                <Loader2 size={22} className="animate-spin text-zinc-600" />
              ) : fullPreview ? (
                <img
                  src={fullPreview}
                  alt={current?.file_name ?? "原图预览"}
                  className="m-auto max-w-none select-none"
                  draggable={false}
                  title="拖动查看局部，点击返回适应窗口（Z）"
                />
              ) : null}
            </div>
          ) : (
            <div
              className="flex min-h-0 flex-1 cursor-zoom-in items-center justify-center"
              onClick={toggleZoom}
              title="点击查看 100% 焦点（Z）"
            >
              {previewLoading && (
                <Loader2 size={22} className="absolute animate-spin text-zinc-600" />
              )}
              {preview ? (
                <img
                  src={preview}
                  alt={current?.file_name ?? "预览"}
                  className="max-h-full max-w-full object-contain p-4"
                />
              ) : (
                !previewLoading &&
                  (items.length > 0 ? (
                    <div className="space-y-1 text-center">
                      <ImageDown size={26} className="mx-auto text-zinc-700" />
                      <p className="text-[12px] text-zinc-500">当前筛选下没有照片</p>
                      <p className="text-[11px] text-zinc-600">
                        切到「全部」查看所有照片、把「拍摄日期」切回全部日期，或切到「未标记」扫尾
                      </p>
                    </div>
                  ) : (
                <div className="max-w-[380px] space-y-3 px-6 text-left">
                  <div className="flex items-center gap-2">
                    <ImageDown size={20} className="text-zinc-600" />
                    <p className="text-[12px] font-medium text-zinc-300">四步完成初筛</p>
                  </div>
                  <ol className="space-y-2 text-[11px] leading-5 text-zinc-500">
                    <li>
                      <span className="mr-1.5 font-mono text-accent">1</span>
                      选目录（支持 jpg / jpeg / heic / heif，RAW 等其他格式不会出现在列表），
                      佳能 / 索尼分开载入
                    </li>
                    <li>
                      <span className="mr-1.5 font-mono text-accent">2</span>
                      选完会自动载入；足球建议连拍间隔 2 秒，同一次进攻自动成组
                    </li>
                    <li>
                      <span className="mr-1.5 font-mono text-accent">3</span>
                      P 保留 / X 淘汰 / U 撤销；Shift + ← → 整组跳转，一组只留 1–2 张
                    </li>
                    <li>
                      <span className="mr-1.5 font-mono text-accent">4</span>
                      「导出保留」出交付图；或「写回星标」后让 Lightroom 按 3★ 筛选精修
                    </li>
                  </ol>
                  <p className="text-[10px] leading-4 text-zinc-600">
                    相机里已打星标的照片会自动预置为「保留」，不必重复查看。
                  </p>
                </div>
              ))
          )}
            </div>
          )}

          {current && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-10">
              <div>
                <p className="font-mono text-[12px] text-zinc-200">
                  {current.file_name}
                  {current.rating ? (
                    <span className="ml-2 align-middle text-[11px] text-warn">
                      {"★".repeat(current.rating)}
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                  #{currentIndex + 1} / {dayItems.length} · {clockLabel(current.epoch)} ·{" "}
                  {formatBytes(current.size)}
                </p>
              </div>
              <span
                className={`rounded-md border px-2 py-1 font-mono text-[10px] ${
                  marks[current.path] === "keep"
                    ? "border-success/40 text-success"
                    : marks[current.path] === "cull"
                      ? "border-danger/40 text-danger"
                      : "border-white/10 text-zinc-500"
                }`}
              >
                {marks[current.path] === "keep"
                  ? "KEEP"
                  : marks[current.path] === "cull"
                    ? "CULL"
                    : "UNMARKED"}
              </span>
            </div>
          )}

          <button
            type="button"
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-zinc-300 hover:bg-black/70 disabled:opacity-30"
            onClick={() => jumpGroup(-1)}
            disabled={!currentGroup || groupRanges.indexOf(currentGroup) === 0}
            title="上一组"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-zinc-300 hover:bg-black/70 disabled:opacity-30"
            onClick={() => jumpGroup(1)}
            disabled={
              !currentGroup || groupRanges.indexOf(currentGroup) === groupRanges.length - 1
            }
            title="下一组"
          >
            <ChevronRight size={16} />
          </button>
        </section>

        <aside className="flex w-[268px] shrink-0 flex-col border-l border-white/5">
          <div className="border-b border-white/5 px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
              Burst Group
            </p>
            <p className="mt-1 text-[12px] text-zinc-300">
              {currentGroup
                ? `第 ${groupRanges.indexOf(currentGroup) + 1} / ${groupRanges.length} 组 · ${
                    currentGroup.end - currentGroup.start
                  } 张`
                : "尚未载入照片"}
            </p>
            <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
              {currentGroup
                ? `${clockLabel(dayItems[currentGroup.start].epoch)} → ${clockLabel(
                    dayItems[currentGroup.end - 1].epoch
                  )}`
                : "载入后按拍摄时间分组，足球建议间隔 2 秒"}
            </p>
          </div>

          <div className="grid grid-cols-4 gap-1 border-b border-white/5 p-3">
            {filters.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => {
                  setFilter(entry.key);
                  setCursor(0);
                }}
                className={`rounded-md px-1 py-1.5 text-center text-[10px] transition-colors ${
                  filter === entry.key
                    ? "bg-accent/15 text-zinc-100 ring-1 ring-accent/30"
                    : "text-zinc-500 hover:bg-white/[0.04]"
                }`}
              >
                <span className="block">{entry.label}</span>
                <span className="block font-mono text-[10px] text-zinc-600">{entry.count}</span>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
              Current Burst
            </p>
            {currentGroup ? (
              <>
                <div className="grid grid-cols-4 gap-1">
                  {dayItems.slice(currentGroup.start, currentGroup.end).map((item, offset) => {
                    const absolute = currentGroup.start + offset;
                    return (
                      <GroupThumb
                        key={item.path}
                        item={item}
                        active={absolute === currentIndex}
                        mark={marks[item.path]}
                        rotation={rotations[item.path] ?? 0}
                        onClick={() => {
                          const position = visible.indexOf(absolute);
                          if (position >= 0) setCursor(position);
                        }}
                      />
                    );
                  })}
                </div>
                {currentGroup.end - currentGroup.start > 1 && (
                  <p className="mt-2 text-[10px] leading-4 text-zinc-600">
                    点缩略图可直接跳转。组内优先留最锐的 1–2 张，其余按 X 淘汰，
                    处理完用 Shift + → 跳到下一组。
                  </p>
                )}
              </>
            ) : (
              <div className="space-y-1.5 text-[11px] leading-5 text-zinc-600">
                <p>载入照片后，这里显示当前连拍组的所有帧。</p>
                <p>缩略图上的绿点表示保留、红点表示淘汰；正在看的这张有紫色描边。</p>
              </div>
            )}
          </div>

          <div className="space-y-2 border-t border-white/5 p-3">
            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                className="btn-muted justify-center py-2 text-[11px]"
                onClick={() => setMark("keep")}
                disabled={!current}
                title="保留这张（快捷键 P），标记后自动跳下一张"
              >
                <Check size={13} className="text-success" />
                保留
              </button>
              <button
                type="button"
                className="btn-muted justify-center py-2 text-[11px]"
                onClick={() => setMark("cull")}
                disabled={!current}
                title="淘汰这张（快捷键 X）"
              >
                <X size={13} className="text-danger" />
                淘汰
              </button>
              <button
                type="button"
                className="btn-muted justify-center py-2 text-[11px]"
                onClick={() => setMark(null)}
                disabled={!current}
                title="清除标记（快捷键 U），这张回到未标记"
              >
                清除
              </button>
            </div>

            {progress && (
              <div>
                <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-zinc-500">
                  <span>
                    {progress.done} / {progress.total}
                  </span>
                  <span>{Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-ink-700">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{
                      width: `${(progress.done / Math.max(progress.total, 1)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            <button
              type="button"
              className="btn-primary w-full justify-center py-2 text-[12px]"
              onClick={() => void handleCopyKept()}
              disabled={copying || keptItems.length === 0}
              title="把保留的 JPG 原片原样复制到交付目录，不重新编码，可直接导入 Lightroom"
            >
              {copying ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Copy size={14} />
              )}
              {copying ? "复制中" : `复制保留原片 ${keptItems.length} 张`}
            </button>
            <button
              type="button"
              className="btn-muted w-full justify-center py-2 text-[11px]"
              onClick={() => void handleExportKept()}
              disabled={exporting || keptItems.length === 0}
              title="把保留项导出成交付小图（会重新编码，适合发客户预览）"
            >
              {exporting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              {exporting ? "导出中" : `导出保留小图 ${keptItems.length} 张`}
            </button>
            {exporting && (
              <button
                type="button"
                className="btn-ghost w-full justify-center py-1.5 text-[11px]"
                onClick={() => {
                  cancelRef.current = true;
                }}
              >
                停止
              </button>
            )}
            <button
              type="button"
              className="btn-muted w-full justify-center py-2 text-[11px]"
              onClick={() => void handleExportCsv()}
              disabled={dayItems.length === 0}
              title="导出全部照片的保留/淘汰状态清单，可发给编辑核对"
            >
              <FileSpreadsheet size={13} />
              导出挑片清单 CSV
            </button>
            <button
              type="button"
              className="btn-muted w-full justify-center py-2 text-[11px]"
              onClick={() => void handleWriteRatings()}
              disabled={writingRatings || dayItems.length === 0}
              title="保留写 3 星、淘汰写 0 星，写入 JPG 的 XMP，Lightroom 可直接按星标筛选"
            >
              {writingRatings ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Star size={13} />
              )}
              写回星标到文件（保留 3★ / 淘汰 0★）
            </button>

            <p className="text-[10px] leading-4 text-zinc-600">
              原片复制不压缩、带哈希校验，可直接进 Lightroom；小图导出按当前参数：长边{" "}
              {settings.maxEdge}px · 质量 {settings.quality}
              {settings.maxBytesKB > 0 ? ` · 上限 ${settings.maxBytesKB} KB` : ""}
              （可在全局设置调整）
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

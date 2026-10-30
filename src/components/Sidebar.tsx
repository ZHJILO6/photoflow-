import { Aperture, FolderInput, Images, ScanSearch, Settings2, SlidersHorizontal } from "lucide-react";
import type { ViewKey } from "../types";

interface SidebarProps {
  active: ViewKey;
  onChange: (view: ViewKey) => void;
  libraryRoot: string | null;
  fileCount: number;
}

const items: Array<{
  key: ViewKey;
  label: string;
  hint: string;
  icon: typeof ScanSearch;
}> = [
  { key: "picker", label: "快速找片", hint: "Picker & Matcher", icon: ScanSearch },
  { key: "cull", label: "连拍挑片", hint: "Burst Culling", icon: SlidersHorizontal },
  { key: "ingester", label: "卡导入与归档", hint: "Ingester", icon: FolderInput },
  { key: "export", label: "批量导出", hint: "Batch Export", icon: Images },
  { key: "settings", label: "全局设置", hint: "Settings", icon: Settings2 },
];

export default function Sidebar({
  active,
  onChange,
  libraryRoot,
  fileCount,
}: SidebarProps) {
  return (
    <aside className="flex h-full w-[232px] shrink-0 flex-col border-r border-white/5 bg-ink-950">
      <div className="flex items-center gap-3 px-5 pb-5 pt-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 ring-1 ring-accent/30">
          <Aperture className="text-accent" size={18} />
        </div>
        <div className="leading-tight">
          <p className="text-[15px] font-semibold tracking-tight text-zinc-100">
            PhotoFlow
          </p>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
            Picker
          </p>
        </div>
      </div>

      <nav className="flex flex-col gap-1 px-3">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onChange(item.key)}
              className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                isActive
                  ? "bg-accent/10 text-zinc-100 ring-1 ring-accent/25"
                  : "text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300"
              }`}
            >
              <Icon
                size={16}
                className={isActive ? "text-accent" : "text-zinc-600 group-hover:text-zinc-400"}
              />
              <span className="flex-1">
                <span className="block text-[13px] font-medium">{item.label}</span>
                <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-600">
                  {item.hint}
                </span>
              </span>
              {isActive && <span className="h-1 w-1 rounded-full bg-accent" />}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto space-y-3 border-t border-white/5 p-4">
        <div className="rounded-lg border border-white/5 bg-ink-800 p-3">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
            Current Library
          </p>
          <p className="truncate text-[11px] text-zinc-400" title={libraryRoot ?? undefined}>
            {libraryRoot ?? "尚未扫描目录"}
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <span className={`dot ${fileCount > 0 ? "bg-success" : "bg-zinc-600"}`} />
            <span className="font-mono text-[11px] text-zinc-500">
              {fileCount > 0 ? `${fileCount.toLocaleString()} files indexed` : "index idle"}
            </span>
          </div>
        </div>
        <p className="px-1 font-mono text-[10px] leading-relaxed text-zinc-700">
          v0.1.0 · open source
          <br />
          RAW/JPG workflow for photographers
        </p>
      </div>
    </aside>
  );
}

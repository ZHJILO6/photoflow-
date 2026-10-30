import { Gauge, ImageDown, Keyboard, Palette } from "lucide-react";
import type { AppSettings } from "../types";

interface SettingsViewProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}

const edgeOptions = [1200, 1600, 2048, 2560, 3200];

export default function SettingsView({ settings, onChange }: SettingsViewProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-white/5 px-6 py-4">
        <p className="text-[15px] font-semibold tracking-tight text-zinc-100">全局设置</p>
        <p className="mt-0.5 text-[11px] text-zinc-500">预览导出参数与工作流快捷键</p>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
        <section className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <ImageDown size={14} className="text-accent" />
              <span className="text-[13px] font-medium text-zinc-200">内嵌预览导出</span>
            </div>
            <span className="font-mono text-[10px] text-zinc-600">fast_image_resize · SIMD</span>
          </div>
          <div className="grid gap-5 p-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="max-edge">
                Max Edge (px)
              </label>
              <select
                id="max-edge"
                className="field"
                value={settings.maxEdge}
                onChange={(event) =>
                  onChange({ ...settings, maxEdge: Number(event.target.value) })
                }
              >
                {edgeOptions.map((edge) => (
                  <option key={edge} value={edge}>
                    {edge} px
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] text-zinc-600">
                长边等比缩放上限，原图更小时保持原尺寸。
              </p>
            </div>

            <div>
              <label className="label" htmlFor="quality">
                JPEG Quality
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="quality"
                  type="range"
                  min={60}
                  max={100}
                  step={1}
                  value={settings.quality}
                  onChange={(event) =>
                    onChange({ ...settings, quality: Number(event.target.value) })
                  }
                  className="h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-600 accent-[#8257E5]"
                />
                <span className="w-10 shrink-0 text-right font-mono text-[12px] text-zinc-300">
                  {settings.quality}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-600">
                质量越高体积越大；网页预览建议 80–88。
              </p>
            </div>

            <div>
              <label className="label" htmlFor="max-bytes">
                单张体积上限 (KB)
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="max-bytes"
                  type="number"
                  min={0}
                  step={100}
                  className="field"
                  value={settings.maxBytesKB}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      maxBytesKB: Math.max(0, Number(event.target.value) || 0),
                    })
                  }
                />
                <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                  {settings.maxBytesKB > 0 ? `${(settings.maxBytesKB / 1024).toFixed(1)} MB` : "不限"}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-600">
                0 表示不限。超过上限时先降质量（最低 48），再降长边（最低 320px）。
              </p>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Keyboard size={14} className="text-success" />
              <span className="text-[13px] font-medium text-zinc-200">快捷键</span>
            </div>
          </div>
          <div className="divide-y divide-white/5 px-4">
            {[
              { keys: "Ctrl + L", action: "清空查询文本" },
              { keys: "Ctrl + V", action: "在查询框内粘贴" },
              { keys: "Enter", action: "在目录输入框内立即扫描" },
            ].map((row) => (
              <div key={row.keys} className="flex items-center justify-between py-2.5">
                <span className="text-[12px] text-zinc-400">{row.action}</span>
                <span className="rounded-md border border-white/10 bg-ink-700 px-2 py-1 font-mono text-[11px] text-zinc-300">
                  {row.keys}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Gauge size={14} className="text-accent" />
              <span className="text-[13px] font-medium text-zinc-200">性能基线</span>
            </div>
          </div>
          <div className="grid gap-3 p-4 sm:grid-cols-3">
            {[
              { title: "扫描", value: "< 3s", hint: "10,000+ 文件 / walkdir + rayon" },
              { title: "哈希", value: "1 MB", hint: "xxHash64 缓冲读取" },
              { title: "拷贝", value: "2 MB", hint: "双向流式 + 回读校验" },
            ].map((item) => (
              <div key={item.title} className="rounded-lg border border-white/5 bg-ink-900/60 p-3">
                <p className="font-mono text-[16px] text-zinc-100">{item.value}</p>
                <p className="mt-0.5 text-[12px] text-zinc-400">{item.title}</p>
                <p className="mt-1 text-[10px] leading-4 text-zinc-600">{item.hint}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Palette size={14} className="text-accent" />
              <span className="text-[13px] font-medium text-zinc-200">界面主题</span>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4">
            <span className="h-8 w-8 rounded-md border border-white/10 bg-[#121214]" />
            <span className="h-8 w-8 rounded-md bg-[#8257E5]" />
            <span className="h-8 w-8 rounded-md bg-[#04D361]" />
            <p className="ml-2 text-[11px] text-zinc-500">
              专业剪辑暗色主题 · #121214 / #8257E5 / #04D361
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

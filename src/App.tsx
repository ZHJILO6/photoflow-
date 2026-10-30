import { useState } from "react";
import BatchExportView from "./components/BatchExportView";
import CullView from "./components/CullView";
import IngesterView from "./components/IngesterView";
import MatcherView from "./components/MatcherView";
import Sidebar from "./components/Sidebar";
import SettingsView from "./components/SettingsView";
import type { AppSettings, ScanReport, ViewKey } from "./types";

export default function App() {
  const [view, setView] = useState<ViewKey>("picker");
  const [settings, setSettings] = useState<AppSettings>({
    maxEdge: 2048,
    quality: 88,
    maxBytesKB: 0,
    autoImport: false,
  });
  const [exportDir, setExportDir] = useState("");
  const [archiveDir, setArchiveDir] = useState("");
  const [scan, setScan] = useState<ScanReport | null>(null);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-ink-900 text-zinc-200">
      <Sidebar
        active={view}
        onChange={setView}
        libraryRoot={scan?.root ?? null}
        fileCount={scan?.total ?? 0}
      />

      <main className="flex h-full min-w-0 flex-1 flex-col">
        {view === "picker" && (
          <MatcherView
            settings={settings}
            onSettingsChange={setSettings}
            scan={scan}
            onScanChange={setScan}
            exportDir={exportDir}
            onExportDirChange={setExportDir}
            archiveDir={archiveDir}
            onArchiveDirChange={setArchiveDir}
          />
        )}
        {view === "cull" && <CullView settings={settings} />}
        {view === "ingester" && (
          <IngesterView
            archiveDir={archiveDir}
            onArchiveDirChange={setArchiveDir}
            scan={scan}
            settings={settings}
            onSettingsChange={setSettings}
          />
        )}
        {view === "export" && (
          <BatchExportView
            settings={settings}
            onSettingsChange={setSettings}
            exportDir={exportDir}
            onExportDirChange={setExportDir}
          />
        )}
        {view === "settings" && <SettingsView settings={settings} onChange={setSettings} />}
      </main>
    </div>
  );
}

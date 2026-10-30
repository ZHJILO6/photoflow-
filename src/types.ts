export interface ScanReport {
  root: string;
  total: number;
  raw_count: number;
  jpeg_count: number;
  other_count: number;
  duration_ms: number;
}

export interface MatchedFile {
  path: string;
  file_name: string;
  kind: string;
  size: number;
  capture_date: string;
}

export interface MatchPair {
  core_num: number | null;
  raw: MatchedFile | null;
  jpeg: MatchedFile | null;
}

export interface MatchReport {
  hits: MatchPair[];
  hit_count: number;
  raw_hits: number;
  jpeg_hits: number;
  failed_tokens: string[];
  elapsed_ms: number;
}

export interface ExportOutcome {
  dest_path: string;
  width: number;
  height: number;
  bytes: number;
}

export interface ArchiveReport {
  copied: number;
  skipped_duplicates: number;
  skipped_existing: number;
  failed: string[];
  destinations: string[];
  duration_ms: number;
}

export interface ArchiveBucket {
  date: string;
  raw: number;
  jpeg: number;
  other: number;
  bytes: number;
}

export interface ArchiveStats {
  root: string;
  buckets: ArchiveBucket[];
  total_files: number;
  raw_count: number;
  jpeg_count: number;
  total_bytes: number;
  duration_ms: number;
}

export interface DuplicateGroup {
  size: number;
  hash: string;
  files: string[];
}

export interface CleanupReport {
  removed_files: number;
  removed_dirs: number;
  freed_bytes: number;
  failed: string[];
  duration_ms: number;
}

export interface CullItem {
  path: string;
  file_name: string;
  size: number;
  capture_date: string;
  epoch: number;
  rating: number | null;
}

export interface CullScanReport {
  items: CullItem[];
  total_files: number;
  skipped: number;
}

export interface RatingReport {
  written: number;
  cleared: number;
  failed: string[];
  duration_ms: number;
}

export type ViewKey = "picker" | "cull" | "ingester" | "export" | "settings";

export interface AppSettings {
  maxEdge: number;
  quality: number;
  maxBytesKB: number;
  autoImport: boolean;
}

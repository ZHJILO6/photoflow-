/** 连拍分组：按相邻照片拍摄时间间隔切组，返回每组在数组中的 [start, end) 区间。 */
export interface BurstRange {
  start: number;
  end: number;
}

export function groupBursts(epochs: number[], gapSeconds: number): BurstRange[] {
  const ranges: BurstRange[] = [];
  if (epochs.length === 0) return ranges;

  let start = 0;
  for (let index = 1; index < epochs.length; index += 1) {
    const previous = epochs[index - 1];
    const current = epochs[index];
    // 间隔达到阈值即开新组；时间缺失（0）无法判断间隔，单独成组。
    if (!previous || !current || current - previous >= gapSeconds) {
      ranges.push({ start, end: index });
      start = index;
    }
  }
  ranges.push({ start, end: epochs.length });
  return ranges;
}

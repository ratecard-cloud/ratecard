import seriesData from '../../data/history/series.json';
import changesData from '../../data/history/changes.json';

export interface PriceSegment { since: string; hourly: number; monthly: number }
export interface SkuSeries {
  first_seen: string;
  last_seen: string;
  removed?: string;
  segments: PriceSegment[];
}

export type ChangeEvent = {
  date: string;
  type: 'price_changed' | 'sku_added' | 'sku_removed' | 'allowance_changed'
      | 'egress_changed' | 'egress_added' | 'egress_removed';
  provider: string;
  region: string;
  sku?: string;
  [k: string]: unknown;
};

export const SERIES = seriesData as Record<string, SkuSeries>;
export const CHANGES = (changesData as ChangeEvent[])
  .slice()
  .sort((a, b) => b.date.localeCompare(a.date));

/** Newest first, grouped for the changelog page. */
export function changesByDate(limit = 400) {
  const grouped = new Map<string, ChangeEvent[]>();
  for (const c of CHANGES.slice(0, limit)) {
    if (!grouped.has(c.date)) grouped.set(c.date, []);
    grouped.get(c.date)!.push(c);
  }
  return [...grouped.entries()];
}

export type MonthlyMagnitudePoint = {
  monthKey: string;
  year: number;
  month: number;
  targetMagnitude: number;
  eventCount: number;
};

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += ch;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function addMonths(d: Date, delta: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
}

function clampMagnitude(v: number): number {
  return Math.min(8.5, Math.max(3, v));
}

export async function loadMonthlyMagnitudeTimeline(
  csvUrl: string,
): Promise<MonthlyMagnitudePoint[]> {
  const raw = await fetch(csvUrl).then((r) => r.text());
  const rows = parseCsvRows(raw);
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.trim());
  const timeIdx = header.findIndex((h) => h.toLowerCase() === "time");
  const magIdx = header.findIndex((h) => h.toLowerCase() === "mag");
  if (timeIdx < 0 || magIdx < 0) return [];

  const monthly = new Map<string, { sum: number; count: number; max: number }>();
  let minMonth: Date | null = null;
  let maxMonth: Date | null = null;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length <= Math.max(timeIdx, magIdx)) continue;
    const d = new Date(r[timeIdx]);
    const mag = Number(r[magIdx]);
    if (!Number.isFinite(d.getTime()) || !Number.isFinite(mag)) continue;

    const m = monthStart(d);
    const key = monthKey(m);
    const agg = monthly.get(key) ?? { sum: 0, count: 0, max: -Infinity };
    agg.sum += mag;
    agg.count += 1;
    agg.max = Math.max(agg.max, mag);
    monthly.set(key, agg);

    if (!minMonth || m < minMonth) minMonth = m;
    if (!maxMonth || m > maxMonth) maxMonth = m;
  }

  if (!minMonth || !maxMonth) return [];

  const all: {
    d: Date;
    count: number;
    maxMag: number | null;
  }[] = [];

  let cur = minMonth;
  while (cur <= maxMonth) {
    const key = monthKey(cur);
    const agg = monthly.get(key);
    all.push({
      d: cur,
      count: agg?.count ?? 0,
      maxMag: agg ? agg.max : null,
    });
    cur = addMonths(cur, 1);
  }

  const mags = all.map((m) => m.maxMag);
  let overall = 4.0;
  const finite = mags.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length > 0) {
    overall = finite.reduce((a, b) => a + b, 0) / finite.length;
  }

  const nextKnownIndex = new Array<number>(all.length).fill(-1);
  let next = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].maxMag !== null) next = i;
    nextKnownIndex[i] = next;
  }

  const out: MonthlyMagnitudePoint[] = [];
  let prevKnown: number | null = null;

  for (let i = 0; i < all.length; i++) {
    const item = all[i];
    let target = item.maxMag;
    if (target === null) {
      const nextIdx = nextKnownIndex[i];
      const nextVal = nextIdx >= 0 ? all[nextIdx].maxMag : null;
      target = prevKnown ?? nextVal ?? overall;
    }
    prevKnown = target;

    out.push({
      monthKey: monthKey(item.d),
      year: item.d.getUTCFullYear(),
      month: item.d.getUTCMonth() + 1,
      targetMagnitude: clampMagnitude(target),
      eventCount: item.count,
    });
  }

  return out;
}

export function timelineMonthAtProgress(
  progress: number,
  timeline: MonthlyMagnitudePoint[],
): MonthlyMagnitudePoint | null {
  if (timeline.length === 0) return null;
  const p = Math.min(1, Math.max(0, progress));
  const idx = Math.min(timeline.length - 1, Math.floor(p * (timeline.length - 1)));
  return timeline[idx] ?? null;
}

export function timelineMonthAtDistance(
  distanceUnits: number,
  unitsPerMonth: number,
  timeline: MonthlyMagnitudePoint[],
): MonthlyMagnitudePoint | null {
  if (timeline.length === 0) return null;
  const safeUnits = Math.max(1e-6, unitsPerMonth);
  const idx = Math.floor(Math.max(0, distanceUnits) / safeUnits);
  return timeline[Math.min(timeline.length - 1, idx)] ?? null;
}

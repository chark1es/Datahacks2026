export type PgvManifest = {
  version: number;
  source: string;
  gridWidth: number;
  gridHeight: number;
  count: number;
  stride: number;
  bytesPerSample: number;
  globalMax: number;
  globalMean: number;
  description?: string;
  paramsNames?: string[];
  paramsUnits?: string[];
  paramsStride?: number[][];
};

export async function loadPgvDataset(): Promise<{
  manifest: PgvManifest;
  data: Float32Array;
  params: number[][] | null;
}> {
  const manifest = (await fetch("/data/pgv-loh-manifest.json").then((r) =>
    r.json(),
  )) as PgvManifest;
  const buf = await fetch("/data/pgv-loh-data.bin").then((r) =>
    r.arrayBuffer(),
  );
  const data = new Float32Array(buf);
  const expected = manifest.count * manifest.gridWidth * manifest.gridHeight;
  if (data.length !== expected) {
    throw new Error(
      `PGV buffer length ${data.length} !== expected ${expected}`,
    );
  }
  return { manifest, data, params: manifest.paramsStride ?? null };
}

/** Progress along road 0..1 → scenario index (dataset order, not clock time). */
export function scenarioIndexFromProgress(
  progress: number,
  count: number,
): number {
  if (count <= 1) return 0;
  const p = Math.min(1, Math.max(0, progress));
  return Math.min(count - 1, Math.floor(p * (count - 1)));
}

export function samplePgvBilinear(
  data: Float32Array,
  manifest: PgvManifest,
  scenarioIndex: number,
  u: number,
  v: number,
): number {
  const { gridWidth: gw, gridHeight: gh } = manifest;
  const x = u * (gw - 1);
  const y = v * (gh - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, gw - 1);
  const y1 = Math.min(y0 + 1, gh - 1);
  const tx = x - x0;
  const ty = y - y0;
  const o = scenarioIndex * gw * gh;
  const at = (ix: number, iy: number) => data[o + iy * gw + ix];
  const a = at(x0, y0);
  const b = at(x1, y0);
  const c = at(x0, y1);
  const d = at(x1, y1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Horizontal PGV gradient (finite difference on the map), data-only. */
export function samplePgvGradient(
  data: Float32Array,
  manifest: PgvManifest,
  scenarioIndex: number,
  u: number,
  v: number,
  du: number,
  dv: number,
): { gx: number; gz: number } {
  const su = Math.min(1, Math.max(0, u + du));
  const sv = Math.min(1, Math.max(0, v + dv));
  const pu = Math.min(1, Math.max(0, u - du));
  const pv = Math.min(1, Math.max(0, v - dv));
  return {
    gx:
      (samplePgvBilinear(data, manifest, scenarioIndex, su, v) -
        samplePgvBilinear(data, manifest, scenarioIndex, pu, v)) /
      (2 * du || 1e-6),
    gz:
      (samplePgvBilinear(data, manifest, scenarioIndex, u, sv) -
        samplePgvBilinear(data, manifest, scenarioIndex, u, pv)) /
      (2 * dv || 1e-6),
  };
}

export function maxPgvForScenario(
  data: Float32Array,
  manifest: PgvManifest,
  scenarioIndex: number,
): number {
  const { gridWidth: gw, gridHeight: gh } = manifest;
  const o = scenarioIndex * gw * gh;
  let m = 0;
  for (let i = 0; i < gw * gh; i++) {
    const v = data[o + i];
    if (v > m) m = v;
  }
  return m;
}

export type ScenarioParams = {
  depthKm: number;
  strikeDeg: number;
  dipDeg: number;
  rakeDeg: number;
};

export function scenarioParamsAt(
  params: number[][] | null,
  scenarioIndex: number,
): ScenarioParams | null {
  if (!params || scenarioIndex < 0 || scenarioIndex >= params.length) return null;
  const row = params[scenarioIndex];
  if (!row || row.length < 4) return null;
  return {
    depthKm: row[0] ?? 0,
    strikeDeg: row[1] ?? 0,
    dipDeg: row[2] ?? 0,
    rakeDeg: row[3] ?? 0,
  };
}

/**
 * Heuristic game-side estimate of moment magnitude Mw from PGV + depth.
 * PGV is in m/s in this dataset.
 */
export function estimateMagnitudeMw(
  maxPgvMs: number,
  params: ScenarioParams | null,
): number {
  const pgvCmS = Math.max(0.05, maxPgvMs * 100);
  const baseMw = 3.6 + 1.1 * Math.log10(pgvCmS);
  const depthCorrection = params ? 0.02 * (params.depthKm - 10) : 0;
  const mw = baseMw + depthCorrection;
  return Math.min(8.5, Math.max(3, mw));
}

/**
 * Inverse of estimateMagnitudeMw (before final clamp): target Mw -> PGV (m/s).
 * This lets gameplay scale a sampled scenario to a specific target magnitude.
 */
export function pgvMsForMagnitudeMw(
  targetMw: number,
  params: ScenarioParams | null,
): number {
  const mw = Math.min(8.5, Math.max(3, targetMw));
  const depthCorrection = params ? 0.02 * (params.depthKm - 10) : 0;
  const pgvCmS = Math.pow(10, (mw - depthCorrection - 3.6) / 1.1);
  return Math.max(0.0005, pgvCmS / 100);
}

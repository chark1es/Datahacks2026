/** World Z maps to timeline; X is lateral. Tunable road extents (world units). */
export const ROAD = {
  zMin: -48,
  zMax: 48,
  xHalf: 12,
} as const;

export const TILES_X = 10;
export const TILES_Z = 20;

export const tileSizeX = (2 * ROAD.xHalf) / TILES_X;
export const tileSizeZ = (ROAD.zMax - ROAD.zMin) / TILES_Z;

/** Car world Z → progress 0 (start) .. 1 (end) along scenario axis */
export function progressFromCarZ(z: number): number {
  const { zMin, zMax } = ROAD;
  return (z - zMin) / (zMax - zMin);
}

/** Map world (x, z) to PGV sample coords u, v in [0, 1]² (easting / northing). */
export function worldToUv(x: number, z: number): { u: number; v: number } {
  const u = (x + ROAD.xHalf) / (2 * ROAD.xHalf);
  const v = (z - ROAD.zMin) / (ROAD.zMax - ROAD.zMin);
  return {
    u: Math.min(1, Math.max(0, u)),
    v: Math.min(1, Math.max(0, v)),
  };
}

export function tileCenter(ix: number, iz: number): { x: number; z: number } {
  return {
    x: -ROAD.xHalf + (ix + 0.5) * tileSizeX,
    z: ROAD.zMin + (iz + 0.5) * tileSizeZ,
  };
}

export function tileUv(ix: number, iz: number): { u: number; v: number } {
  return {
    u: (ix + 0.5) / TILES_X,
    v: (iz + 0.5) / TILES_Z,
  };
}

export type DamageTier = 0 | 1 | 2 | 3;

export function magnitudeToDamageTier(mw: number): DamageTier {
  if (!Number.isFinite(mw)) return 0;
  if (mw >= 6) return 3;
  if (mw >= 5 && mw < 6) return 2;
  if (mw > 4 && mw < 5) return 1;
  return 0;
}

export function computeTimelineProgress(
  forwardDistance: number,
  unitsPerMonth: number,
  totalMonths: number,
): { progress01: number; remainingMonths: number } {
  if (totalMonths <= 0 || unitsPerMonth <= 0) {
    return { progress01: 0, remainingMonths: 0 };
  }

  if (totalMonths === 1) {
    return { progress01: 1, remainingMonths: 0 };
  }

  const safeDistance = Math.max(0, forwardDistance);
  const monthIndex = Math.floor(safeDistance / unitsPerMonth);
  const clampedMonthIndex = Math.min(totalMonths - 1, Math.max(0, monthIndex));
  const progress01 = clampedMonthIndex / (totalMonths - 1);
  const remainingMonths = Math.max(0, totalMonths - 1 - clampedMonthIndex);

  return { progress01, remainingMonths };
}

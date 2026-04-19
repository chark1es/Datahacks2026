"use client";

import BlockOnLand from "./BlockOnLand";

export default function GameCanvas() {
  return (
    <div className="relative h-dvh w-full">
      <BlockOnLand />
      <p className="pointer-events-none absolute bottom-4 left-4 font-[family-name:var(--font-display)] text-xs text-[var(--text-muted)]">
        WASD / arrows - road position is a month-by-month quake timeline; hit buildings to trigger that month&apos;s quake
      </p>
    </div>
  );
}

import { magnitudeToDamageTier, type DamageTier } from "@/lib/seismicDamage";
import type { RigidBody } from "@dimforge/rapier3d-compat";
import type { FaultEvent, WorldDamageState } from "@/components/sim/types";
import { hashString, seededRand } from "@/components/sim/utils";

type DamageSystemDeps = {
  scheduleCollapsesNearCar: (simTime: number, count: number, carBody: RigidBody) => void;
};

export type DamageSystem = {
  faultEvents: FaultEvent[];
  worldDamage: WorldDamageState;
  applyMagnitudeDamage: (magnitudeMw: number, simTime: number, carBody: RigidBody) => void;
};

export function createDamageSystem({ scheduleCollapsesNearCar }: DamageSystemDeps): DamageSystem {
  const faultEvents: FaultEvent[] = [];
  const worldDamage: WorldDamageState = {
    maxTier: 0,
    tier1Applied: false,
    tier2Applied: false,
    tier3Events: 0,
  };

  const createFaultEvent = (strength: number, focusZ: number) => {
    const seed = hashString(`${focusZ.toFixed(2)}-${strength.toFixed(3)}-${worldDamage.tier3Events}`);
    const r = (n: number) => seededRand(seed + n * 31);
    const angle = (r(1) - 0.5) * Math.PI * 0.8;
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    const normalX = -dirZ;
    const normalZ = dirX;

    const event: FaultEvent = {
      originX: (r(2) - 0.5) * 18,
      originZ: focusZ - 8 + (r(3) - 0.5) * 20,
      dirX,
      dirZ,
      normalX,
      normalZ,
      length: 34 + strength * 28 + r(4) * 18,
      split: 0.08 + strength * 0.28,
      drop: 0.05 + strength * 0.2,
      width: 2.4 + strength * 1.8,
      progress: 0,
      speed: 0.42 + strength * 0.28,
    };

    faultEvents.push(event);
    if (faultEvents.length > 12) {
      faultEvents.shift();
    }
  };

  const applyMagnitudeDamage = (magnitudeMw: number, simTime: number, carBody: RigidBody) => {
    const tier = magnitudeToDamageTier(magnitudeMw);
    if (tier === 0) return;
    const collapseCount = Math.max(1, Math.min(7, Math.round((magnitudeMw - 3.9) * 1.9)));

    worldDamage.maxTier = Math.max(worldDamage.maxTier, tier) as DamageTier;

    if (tier >= 1 && !worldDamage.tier1Applied) {
      worldDamage.tier1Applied = true;
      createFaultEvent(0.5, carBody.translation().z);
    }

    if (tier >= 1) {
      scheduleCollapsesNearCar(simTime, Math.max(1, Math.min(2, collapseCount)), carBody);
    }

    if (tier >= 2) {
      if (!worldDamage.tier2Applied) {
        worldDamage.tier2Applied = true;
        createFaultEvent(0.75, carBody.translation().z);
      }
      scheduleCollapsesNearCar(simTime, Math.max(2, Math.min(4, collapseCount + 1)), carBody);
    }

    if (tier >= 3) {
      worldDamage.tier3Events += 1;
      createFaultEvent(1.15, carBody.translation().z);
      createFaultEvent(1.05, carBody.translation().z - 10);
      scheduleCollapsesNearCar(
        simTime,
        Math.min(6, Math.max(3, collapseCount + Math.floor(worldDamage.tier3Events / 2))),
        carBody,
      );
    }
  };

  return {
    faultEvents,
    worldDamage,
    applyMagnitudeDamage,
  };
}

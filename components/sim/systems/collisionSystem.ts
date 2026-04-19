import type { EventQueue } from "@dimforge/rapier3d-compat";

export type CollisionSystem = {
  consumeCarBuildingHit: () => boolean;
};

type CollisionSystemOptions = {
  eventQueue: EventQueue;
  carColliderHandles: Set<number>;
  buildingColliderHandles: Set<number>;
};

export function createCollisionSystem({
  eventQueue,
  carColliderHandles,
  buildingColliderHandles,
}: CollisionSystemOptions): CollisionSystem {
  const consumeCarBuildingHit = () => {
    let hitBuilding = false;

    eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      if (
        (carColliderHandles.has(h1) && buildingColliderHandles.has(h2)) ||
        (carColliderHandles.has(h2) && buildingColliderHandles.has(h1))
      ) {
        hitBuilding = true;
      }
    });

    return hitBuilding;
  };

  return {
    consumeCarBuildingHit,
  };
}

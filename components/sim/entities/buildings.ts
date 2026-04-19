import * as THREE from "three";
import { CHUNK_LENGTH } from "@/components/sim/constants";
import type { PhysicsContext } from "@/components/sim/physics";
import { copyRigidBodyToObject3D, setBodyTypeDynamic, setBodyTypeKinematic } from "@/components/sim/physics";
import type { BuildingChunkData, BuildingData, PersistedBuildingState } from "@/components/sim/types";
import { hashString, seededRand } from "@/components/sim/utils";

type PendingDamageItem = {
  key: string;
  at: number;
  strength?: number;
};

export type BuildingSystem = {
  buildingBaseColliderHandles: Set<number>;
  createBuildingsForChunk: (chunkIndex: number, group: THREE.Group) => BuildingData[];
  removeBuildings: (buildings: BuildingData[]) => void;
  forEachBuilding: (fn: (building: BuildingData) => void) => void;
  scheduleTopBreaksNearCar: (
    simTime: number,
    count: number,
    carBody: import("@dimforge/rapier3d-compat").RigidBody,
    strength: number,
  ) => void;
  scheduleCollapsesNearCar: (simTime: number, count: number, carBody: import("@dimforge/rapier3d-compat").RigidBody) => void;
  processPendingDamage: (simTime: number, carBody: import("@dimforge/rapier3d-compat").RigidBody) => void;
  syncAttachedTopChunks: () => void;
  syncVisualsFromPhysics: () => void;
  detachTopChunks: (
    building: BuildingData,
    impulseDir: THREE.Vector3,
    instantToGround: boolean,
    strength: number,
  ) => void;
  collapseBuilding: (building: BuildingData) => void;
};

const buildingPalettes = [
  { base: 0xd39a6a, top: 0xf1d1a8 },
  { base: 0xc86c5a, top: 0xf0b29b },
  { base: 0x6da0b8, top: 0xb8d9e7 },
  { base: 0x7ea377, top: 0xc7dfbb },
  { base: 0xb8a779, top: 0xe7ddb4 },
  { base: 0x8d86bc, top: 0xd0caef },
];

const BUILDING_BLOCK_TARGET = 1.7;

function getBodyForward(body: import("@dimforge/rapier3d-compat").RigidBody): THREE.Vector3 {
  const r = body.rotation();
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  forward.y = 0;
  if (forward.lengthSq() > 1e-6) {
    forward.normalize();
  } else {
    forward.set(0, 0, -1);
  }
  return forward;
}

function getBodyPosition(body: import("@dimforge/rapier3d-compat").RigidBody): THREE.Vector3 {
  const p = body.translation();
  return new THREE.Vector3(p.x, p.y, p.z);
}

function clampChunkCount(size: number, min: number, max: number) {
  return THREE.MathUtils.clamp(Math.round(size / BUILDING_BLOCK_TARGET), min, max);
}

export function createBuildingSystem(ctx: PhysicsContext): BuildingSystem {
  const loadedBuildingsByKey = new Map<string, BuildingData>();
  const buildingBaseColliderHandles = new Set<number>();
  const persistedBuildingState = new Map<string, PersistedBuildingState>();
  const pendingCrumbles: PendingDamageItem[] = [];

  let nextBuildingId = 1;

  const getPersistedState = (key: string): PersistedBuildingState => {
    const existing = persistedBuildingState.get(key);
    if (existing) return existing;
    const created: PersistedBuildingState = {
      isCollapsed: false,
      collapseDirection: 1,
      scatterSeed: hashString(`${key}-scatter`),
    };
    persistedBuildingState.set(key, created);
    return created;
  };

  const detachChunks = (
    building: BuildingData,
    impulseDir: THREE.Vector3,
    instantToGround: boolean,
    strength: number,
  ) => {
    if (building.isCollapsed && building.chunks.every((chunk) => chunk.detached)) return;

    const persisted = getPersistedState(building.key);
    const towardRoad = (-Math.sign(building.baseX || 1) || 1) as -1 | 1;
    persisted.isCollapsed = true;
    persisted.collapseDirection = towardRoad;
    building.isCollapsed = true;

    const seed = persisted.scatterSeed;

    building.chunks.forEach((chunk, idx) => {
      if (chunk.detached) return;
      chunk.detached = true;
      buildingBaseColliderHandles.delete(chunk.collider.handle);
      setBodyTypeDynamic(ctx, chunk.body);

      if (instantToGround) {
        const laneTargetX = towardRoad * (1.4 + seededRand(seed + idx * 23 + 1) * 4.3);
        const roadSlide =
          towardRoad *
          (Math.max(0, Math.abs(building.baseX) - Math.abs(laneTargetX)) * (0.72 + strength * 0.22) +
            seededRand(seed + idx * 23 + 2) * 1.8);
        const spreadX = roadSlide + (seededRand(seed + idx * 23 + 3) - 0.5) * 1.2;
        const spreadZ = (seededRand(seed + idx * 23 + 4) - 0.5) * (building.depth + 8);
        const y = chunk.halfExtents.y + 0.03 + seededRand(seed + idx * 23 + 5) * 0.12;

        chunk.body.setTranslation(
          {
            x: building.baseX + spreadX,
            y,
            z: building.baseZ + spreadZ,
          },
          true,
        );

        const randomQ = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            (seededRand(seed + idx * 23 + 6) - 0.5) * 1.2,
            seededRand(seed + idx * 23 + 7) * Math.PI,
            (seededRand(seed + idx * 23 + 8) - 0.5) * 1.2,
          ),
        );
        chunk.body.setRotation({ x: randomQ.x, y: randomQ.y, z: randomQ.z, w: randomQ.w }, true);
        chunk.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        chunk.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        chunk.body.sleep();
        return;
      }

      const layerRatio = THREE.MathUtils.clamp(chunk.localOffset.y / Math.max(1, building.height), 0, 1);
      const lateralBias = THREE.MathUtils.clamp(
        (towardRoad * chunk.localOffset.x) / Math.max(0.8, building.width * 0.5) * 0.5 + 0.5,
        0,
        1,
      );
      const streetImpulse = towardRoad * (10 + strength * 10 + layerRatio * 6 + lateralBias * 8);
      const alongRoadImpulse =
        impulseDir.z * (2.5 + strength * 4.2) +
        (seededRand(seed + idx * 19 + 9) - 0.5) * (3.4 + strength * 2.4);
      const liftImpulse = 1.4 + strength * 1.8 + layerRatio * 3.8 + seededRand(seed + idx * 19 + 10) * 1.2;
      const impulse = new THREE.Vector3(
        impulseDir.x * 2 + streetImpulse + (seededRand(seed + idx * 19 + 7) - 0.5) * 2.2,
        liftImpulse,
        alongRoadImpulse,
      );

      chunk.body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
      chunk.body.setAngvel(
        {
          x: (seededRand(seed + idx * 17 + 12) - 0.5) * (3.8 + strength),
          y: (seededRand(seed + idx * 17 + 13) - 0.5) * (3.2 + strength),
          z: towardRoad * (1.2 + strength * 0.45) + (seededRand(seed + idx * 17 + 14) - 0.5) * 2.4,
        },
        true,
      );
    });
  };

  const collapseBuilding = (building: BuildingData) => {
    if (building.isCollapsed) return;
    const towardRoad = (-Math.sign(building.baseX || 1) || 1) as -1 | 1;
    const crumbleDir = new THREE.Vector3(towardRoad, 0, (Math.random() - 0.5) * 0.35).normalize();
    detachChunks(building, crumbleDir, false, 1.75);
  };

  const applyPersistedBuildingState = (building: BuildingData) => {
    const persisted = persistedBuildingState.get(building.key);
    if (!persisted?.isCollapsed) return;
    detachChunks(building, new THREE.Vector3(0, 0, 0), true, 1.15);
  };

  const createBuildingsForChunk = (chunkIndex: number, group: THREE.Group): BuildingData[] => {
    const buildings: BuildingData[] = [];
    const chunkStartZ = chunkIndex * CHUNK_LENGTH;

    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 3; i++) {
        const s = chunkIndex * 100 + (side > 0 ? 50 : 0) + i;
        const width = 4.2 + seededRand(s + 1) * 2.1;
        const depth = 5.2 + seededRand(s + 2) * 2.4;
        const height = 4.2 + seededRand(s + 3) * 8;
        const lateral = side * (13.6 + seededRand(s + 4) * 2.6);
        const z = chunkStartZ + (i + 0.55) * (CHUNK_LENGTH / 3);
        const palette =
          buildingPalettes[Math.floor(seededRand(s + 5) * buildingPalettes.length) % buildingPalettes.length];

        const xCount = clampChunkCount(width, 2, 4);
        const zCount = clampChunkCount(depth, 2, 4);
        const yCount = clampChunkCount(height, 3, 7);
        const blockW = width / xCount;
        const blockD = depth / zCount;
        const blockH = height / yCount;
        const gap = 0.92;

        const anchorBody = ctx.world.createRigidBody(ctx.RAPIER.RigidBodyDesc.fixed().setTranslation(lateral, 0, z));
        const chunks: BuildingChunkData[] = [];

        for (let yi = 0; yi < yCount; yi++) {
          const layerMix = yCount <= 1 ? 1 : yi / (yCount - 1);
          const layerColor = new THREE.Color(palette.base).lerp(new THREE.Color(palette.top), layerMix);

          for (let xi = 0; xi < xCount; xi++) {
            for (let zi = 0; zi < zCount; zi++) {
              const localOffset = new THREE.Vector3(
                (xi - (xCount - 1) / 2) * blockW,
                (yi + 0.5) * blockH,
                (zi - (zCount - 1) / 2) * blockD,
              );

              const halfExtents = new THREE.Vector3((blockW * gap) / 2, (blockH * gap) / 2, (blockD * gap) / 2);

              const chunkMesh = new THREE.Mesh(
                new THREE.BoxGeometry(halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2),
                new THREE.MeshStandardMaterial({ color: layerColor.getHex(), roughness: 0.68, metalness: 0.06 }),
              );
              chunkMesh.castShadow = true;
              chunkMesh.receiveShadow = true;
              group.add(chunkMesh);

              const chunkBody = ctx.world.createRigidBody(
                ctx.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
                  lateral + localOffset.x,
                  localOffset.y,
                  z + localOffset.z,
                ),
              );
              const chunkCollider = ctx.world.createCollider(
                ctx.RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
                  .setFriction(0.58)
                  .setRestitution(0.02)
                  .setActiveEvents(ctx.RAPIER.ActiveEvents.COLLISION_EVENTS),
                chunkBody,
              );
              buildingBaseColliderHandles.add(chunkCollider.handle);

              chunks.push({
                mesh: chunkMesh,
                body: chunkBody,
                collider: chunkCollider,
                localOffset,
                detached: false,
                halfExtents,
              });
            }
          }
        }

        const key = `${chunkIndex}:${side}:${i}:${nextBuildingId++}`;
        const building: BuildingData = {
          key,
          anchorBody,
          chunks,
          baseX: lateral,
          baseZ: z,
          width,
          depth,
          height,
          isCollapsed: false,
        };

        applyPersistedBuildingState(building);
        buildings.push(building);
        loadedBuildingsByKey.set(key, building);
      }
    }

    return buildings;
  };

  const removeBuildings = (buildings: BuildingData[]) => {
    for (const building of buildings) {
      ctx.world.removeRigidBody(building.anchorBody);
      for (const chunk of building.chunks) {
        buildingBaseColliderHandles.delete(chunk.collider.handle);
        ctx.world.removeRigidBody(chunk.body);
      }
      loadedBuildingsByKey.delete(building.key);
    }
  };

  const forEachBuilding = (fn: (building: BuildingData) => void) => {
    for (const building of loadedBuildingsByKey.values()) {
      fn(building);
    }
  };

  const scheduleCollapsesNearCar = (
    simTime: number,
    count: number,
    carBody: import("@dimforge/rapier3d-compat").RigidBody,
  ) => {
    const carPos = getBodyPosition(carBody);
    const forward = getBodyForward(carBody);

    const candidates: { key: string; score: number }[] = [];
    forEachBuilding((building) => {
      if (building.isCollapsed) return;
      const dx = building.baseX - carPos.x;
      const dz = building.baseZ - carPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 82) return;

      const ndx = dx / Math.max(dist, 1e-6);
      const ndz = dz / Math.max(dist, 1e-6);
      const ahead = ndx * forward.x + ndz * forward.z;
      if (ahead < -0.35) return;

      const laneBias = 1 - Math.min(1, Math.abs(building.baseX) / 18);
      const score = ahead * 1.5 - dist * 0.019 + laneBias * 0.45 + Math.random() * 0.35;
      candidates.push({ key: building.key, score });
    });

    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates.slice(0, count);

    selected.forEach((candidate, idx) => {
      if (pendingCrumbles.some((item) => item.key === candidate.key)) return;
      pendingCrumbles.push({ key: candidate.key, at: simTime + idx * 0.24 + Math.random() * 0.16 });
    });
  };

  const scheduleTopBreaksNearCar = (
    simTime: number,
    count: number,
    carBody: import("@dimforge/rapier3d-compat").RigidBody,
  ) => {
    scheduleCollapsesNearCar(simTime, Math.max(1, Math.ceil(count * 0.75)), carBody);
  };

  const processPendingDamage = (simTime: number, carBody: import("@dimforge/rapier3d-compat").RigidBody) => {
    void carBody;
    for (let i = pendingCrumbles.length - 1; i >= 0; i--) {
      const item = pendingCrumbles[i];
      if (item.at > simTime) continue;
      pendingCrumbles.splice(i, 1);
      const building = loadedBuildingsByKey.get(item.key);
      if (!building || building.isCollapsed) continue;
      collapseBuilding(building);
    }
  };

  const syncAttachedTopChunks = () => {
    const anchorPosition = new THREE.Vector3();

    forEachBuilding((building) => {
      const p = building.anchorBody.translation();
      anchorPosition.set(p.x, p.y, p.z);

      for (const chunk of building.chunks) {
        if (chunk.detached) continue;
        if (chunk.body.bodyType() !== ctx.RAPIER.RigidBodyType.KinematicPositionBased) {
          setBodyTypeKinematic(ctx, chunk.body);
        }

        chunk.body.setNextKinematicTranslation({
          x: anchorPosition.x + chunk.localOffset.x,
          y: anchorPosition.y + chunk.localOffset.y,
          z: anchorPosition.z + chunk.localOffset.z,
        });
      }
    });
  };

  const syncVisualsFromPhysics = () => {
    forEachBuilding((building) => {
      for (const chunk of building.chunks) {
        copyRigidBodyToObject3D(chunk.body, chunk.mesh);
      }
    });
  };

  const detachTopChunks = (
    building: BuildingData,
    impulseDir: THREE.Vector3,
    instantToGround: boolean,
    strength: number,
  ) => {
    detachChunks(building, impulseDir, instantToGround, strength);
  };

  return {
    buildingBaseColliderHandles,
    createBuildingsForChunk,
    removeBuildings,
    forEachBuilding,
    scheduleTopBreaksNearCar,
    scheduleCollapsesNearCar,
    processPendingDamage,
    syncAttachedTopChunks,
    syncVisualsFromPhysics,
    detachTopChunks,
    collapseBuilding,
  };
}

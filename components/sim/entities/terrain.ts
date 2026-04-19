import * as THREE from "three";
import {
  CHUNK_LENGTH,
  TERRAIN_MEMBERSHIP,
  TERRAIN_TILES_X,
  TERRAIN_TILES_Z,
  TERRAIN_TILE_THICKNESS,
  TERRAIN_WIDTH,
  WORLD_HALF_X,
} from "@/components/sim/constants";
import type { PhysicsContext } from "@/components/sim/physics";
import { toInteractionGroups } from "@/components/sim/physics";
import { seededRand } from "@/components/sim/utils";
import type { ChunkData, FaultEvent, TerrainTileData, WorldDamageState } from "@/components/sim/types";

const ALL_GROUPS = 0xffff;

type CreateTerrainTilesArgs = {
  ctx: PhysicsContext;
  group: THREE.Group;
  chunkIndex: number;
  roadMaterial: THREE.MeshStandardMaterial;
  shoulderMaterial: THREE.MeshStandardMaterial;
  terrainColliderHandles: Set<number>;
};

export function createTerrainTilesForChunk({
  ctx,
  group,
  chunkIndex,
  roadMaterial,
  shoulderMaterial,
  terrainColliderHandles,
}: CreateTerrainTilesArgs): TerrainTileData[] {
  const terrainTiles: TerrainTileData[] = [];
  const chunkStartZ = chunkIndex * CHUNK_LENGTH;
  const tileSizeX = TERRAIN_WIDTH / TERRAIN_TILES_X;
  const tileSizeZ = CHUNK_LENGTH / TERRAIN_TILES_Z;
  const terrainXMin = -WORLD_HALF_X - 8;

  for (let iz = 0; iz < TERRAIN_TILES_Z; iz++) {
    for (let ix = 0; ix < TERRAIN_TILES_X; ix++) {
      const x = terrainXMin + (ix + 0.5) * tileSizeX;
      const z = chunkStartZ + (iz + 0.5) * tileSizeZ;
      const isRoad = Math.abs(x) < 6.4;

      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(tileSizeX, TERRAIN_TILE_THICKNESS, tileSizeZ),
        (isRoad ? roadMaterial : shoulderMaterial).clone(),
      );
      mesh.position.set(x, -TERRAIN_TILE_THICKNESS / 2, z);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      group.add(mesh);

      const body = ctx.world.createRigidBody(
        ctx.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, -TERRAIN_TILE_THICKNESS / 2, z),
      );
      const colliderDesc = ctx.RAPIER.ColliderDesc.cuboid(
        tileSizeX / 2,
        TERRAIN_TILE_THICKNESS / 2,
        tileSizeZ / 2,
      )
        .setCollisionGroups(toInteractionGroups(TERRAIN_MEMBERSHIP, ALL_GROUPS))
        .setFriction(0.42)
        .setRestitution(0.03);
      const collider = ctx.world.createCollider(colliderDesc, body);
      terrainColliderHandles.add(collider.handle);

      terrainTiles.push({
        mesh,
        body,
        collider,
        baseX: x,
        baseZ: z,
        phase: seededRand(chunkIndex * 997 + iz * 67 + ix * 13) * Math.PI * 2,
        x,
        y: -TERRAIN_TILE_THICKNESS / 2,
        z,
        rotX: 0,
        rotZ: 0,
      });
    }
  }

  return terrainTiles;
}

export function removeTerrainTiles(
  ctx: PhysicsContext,
  terrainTiles: TerrainTileData[],
  terrainColliderHandles: Set<number>,
) {
  for (const tile of terrainTiles) {
    terrainColliderHandles.delete(tile.collider.handle);
    ctx.world.removeRigidBody(tile.body);
  }
}

export function updateTerrainKinematics(
  chunks: Iterable<ChunkData>,
  dt: number,
  simTime: number,
  faultEvents: FaultEvent[],
  worldDamage: WorldDamageState,
) {
  for (const fault of faultEvents) {
    fault.progress = Math.min(1, fault.progress + dt * fault.speed);
  }

  const roughness =
    worldDamage.maxTier >= 3
      ? 0.25 + Math.min(0.32, worldDamage.tier3Events * 0.035)
      : worldDamage.maxTier >= 1
        ? 0.08
        : 0;

  const q = new THREE.Quaternion();
  const e = new THREE.Euler();

  for (const chunk of chunks) {
    for (const tile of chunk.terrainTiles) {
      let targetX = tile.baseX;
      let targetY = -TERRAIN_TILE_THICKNESS / 2;
      let targetZ = tile.baseZ;
      let targetRotX = 0;
      let targetRotZ = 0;

      if (roughness > 0) {
        const wave =
          Math.sin(simTime * 0.8 + tile.phase + tile.baseX * 0.045) * roughness * 0.45 +
          Math.sin(simTime * 0.52 + tile.baseZ * 0.06 - tile.phase * 0.7) * roughness * 0.55;
        targetY += wave;
      }

      for (const fault of faultEvents) {
        const dx = tile.baseX - fault.originX;
        const dz = tile.baseZ - fault.originZ;
        const along = dx * fault.dirX + dz * fault.dirZ;
        const alongHalf = Math.max(1e-6, fault.length * 0.5);
        if (Math.abs(along) > alongHalf) continue;

        const dist = dx * fault.normalX + dz * fault.normalZ;
        const envelope = 1 - Math.abs(along) / alongHalf;
        const gaussian = Math.exp(-(dist * dist) / Math.max(1e-6, fault.width * fault.width));
        const influence = envelope * gaussian * fault.progress;
        if (influence < 0.0015) continue;

        const side = dist >= 0 ? 1 : -1;
        targetX += fault.normalX * side * fault.split * influence;
        targetZ += fault.normalZ * side * fault.split * influence;
        targetY -= fault.drop * influence;
        targetRotX += fault.normalZ * side * 0.07 * influence;
        targetRotZ -= fault.normalX * side * 0.07 * influence;
      }

      const blend = Math.min(1, dt * 2.9);
      tile.x = THREE.MathUtils.lerp(tile.x, targetX, blend);
      tile.y = THREE.MathUtils.lerp(tile.y, targetY, blend);
      tile.z = THREE.MathUtils.lerp(tile.z, targetZ, blend);
      tile.rotX = THREE.MathUtils.lerp(tile.rotX, targetRotX, blend);
      tile.rotZ = THREE.MathUtils.lerp(tile.rotZ, targetRotZ, blend);

      tile.mesh.position.set(tile.x, tile.y, tile.z);
      tile.mesh.rotation.set(tile.rotX, 0, tile.rotZ);

      e.set(tile.rotX, 0, tile.rotZ);
      q.setFromEuler(e);
      tile.body.setNextKinematicTranslation({ x: tile.x, y: tile.y, z: tile.z });
      tile.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  }
}

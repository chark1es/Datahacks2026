import * as THREE from "three";
import { copyRigidBodyToObject3D, setBodyTypeDynamic } from "@/components/sim/physics";
import type { PhysicsContext } from "@/components/sim/physics";
import type { ChunkData, LampPostData } from "@/components/sim/types";
import { createChunkManager } from "@/components/sim/systems/chunkManager";
import { disposeGroupMeshes, seededRand } from "@/components/sim/utils";
import { createTerrainTilesForChunk, removeTerrainTiles } from "@/components/sim/entities/terrain";
import type { BuildingSystem } from "@/components/sim/entities/buildings";
import { CHUNK_LENGTH } from "@/components/sim/constants";

type WorldChunksSystemArgs = {
  scene: THREE.Scene;
  ctx: PhysicsContext;
  buildingSystem: BuildingSystem;
};

export type WorldChunksSystem = {
  loadedChunks: Map<number, ChunkData>;
  terrainColliderHandles: Set<number>;
  syncChunks: (carZ: number) => void;
  toppleLampPostsNear: (carPosition: { x: number; y: number; z: number }, quakeAmplitude: number) => void;
  syncLampPostVisuals: () => void;
  dispose: () => void;
};

export function createWorldChunksSystem({
  scene,
  ctx,
  buildingSystem,
}: WorldChunksSystemArgs): WorldChunksSystem {
  const lampPoleMaterial = new THREE.MeshStandardMaterial({
    color: 0x59636e,
    roughness: 0.78,
    metalness: 0.38,
  });
  const lampHeadMaterial = new THREE.MeshStandardMaterial({
    color: 0x2d3138,
    roughness: 0.62,
    metalness: 0.2,
  });
  const lampGlowMaterial = new THREE.MeshStandardMaterial({
    color: 0xf6e3af,
    emissive: 0xf0d58a,
    emissiveIntensity: 0.25,
    roughness: 0.38,
    metalness: 0.04,
  });

  const addRoadsideGreenery = (group: THREE.Group, chunkIndex: number) => {
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 5; i++) {
        const seed = chunkIndex * 251 + (side > 0 ? 97 : 11) + i * 19;
        const z = chunkIndex * CHUNK_LENGTH + (i + 0.45 + seededRand(seed + 1) * 0.22) * (CHUNK_LENGTH / 5);
        const x = side * (8.4 + seededRand(seed + 2) * 2.4);

        const trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.2, 1.05 + seededRand(seed + 3) * 0.45, 8),
          new THREE.MeshStandardMaterial({ color: 0x5f4632, roughness: 0.96, metalness: 0.03 }),
        );
        trunk.position.set(x, trunk.geometry.parameters.height / 2, z);
        trunk.castShadow = true;
        group.add(trunk);

        const canopy = new THREE.Mesh(
          new THREE.SphereGeometry(0.78 + seededRand(seed + 4) * 0.4, 10, 10),
          new THREE.MeshStandardMaterial({
            color: side > 0 ? 0x5b7f45 : 0x6b8e4f,
            roughness: 0.98,
            metalness: 0.01,
          }),
        );
        canopy.position.set(
          x + (seededRand(seed + 5) - 0.5) * 0.28,
          trunk.position.y + trunk.geometry.parameters.height * 0.5 + 0.78,
          z + (seededRand(seed + 6) - 0.5) * 0.45,
        );
        canopy.scale.set(1, 0.88 + seededRand(seed + 7) * 0.24, 1);
        canopy.castShadow = true;
        group.add(canopy);
      }

      for (let i = 0; i < 7; i++) {
        const seed = chunkIndex * 313 + (side > 0 ? 149 : 43) + i * 23;
        const shrub = new THREE.Mesh(
          new THREE.SphereGeometry(0.42 + seededRand(seed + 1) * 0.24, 8, 8),
          new THREE.MeshStandardMaterial({
            color: side > 0 ? 0x7aa15b : 0x88ad64,
            roughness: 1,
            metalness: 0,
          }),
        );
        shrub.position.set(
          side * (6.9 + seededRand(seed + 2) * 1.2),
          0.32 + seededRand(seed + 3) * 0.08,
          chunkIndex * CHUNK_LENGTH + (i + 0.3 + seededRand(seed + 4) * 0.3) * (CHUNK_LENGTH / 7),
        );
        shrub.scale.set(1.1 + seededRand(seed + 5) * 0.45, 0.72 + seededRand(seed + 6) * 0.22, 1);
        shrub.castShadow = true;
        group.add(shrub);
      }

      for (let i = 0; i < 16; i++) {
        const seed = chunkIndex * 401 + (side > 0 ? 211 : 79) + i * 29;
        const tuft = new THREE.Mesh(
          new THREE.ConeGeometry(0.16 + seededRand(seed + 1) * 0.12, 0.38 + seededRand(seed + 2) * 0.22, 5),
          new THREE.MeshStandardMaterial({
            color: side > 0 ? 0x74b55a : 0x86c56a,
            roughness: 1,
            metalness: 0,
          }),
        );
        tuft.position.set(
          side * (6.4 + seededRand(seed + 3) * 5.8),
          0.18 + seededRand(seed + 4) * 0.08,
          chunkIndex * CHUNK_LENGTH + (i + seededRand(seed + 5)) * (CHUNK_LENGTH / 16),
        );
        tuft.rotation.y = seededRand(seed + 6) * Math.PI;
        tuft.castShadow = true;
        group.add(tuft);
      }
    }
  };

  const createLampPostsForChunk = (group: THREE.Group, chunkIndex: number): LampPostData[] => {
    const lampPosts: LampPostData[] = [];
    const totalPosts = 1 + (seededRand(chunkIndex * 557 + 901) > 0.58 ? 1 : 0);
    const usedSlots = new Set<number>();

    for (let i = 0; i < totalPosts; i++) {
      let slot = Math.floor(seededRand(chunkIndex * 557 + 103 + i * 17) * 5);
      while (usedSlots.has(slot)) {
        slot = (slot + 1) % 5;
      }
      usedSlots.add(slot);

      const side = (seededRand(chunkIndex * 557 + 131 + i * 19) > 0.5 ? 1 : -1) as -1 | 1;
      const seed = chunkIndex * 557 + (side > 0 ? 181 : 59) + slot * 31 + i * 7;
      const height = 4.8 + seededRand(seed + 1) * 0.9;
      const z = chunkIndex * CHUNK_LENGTH + (slot + 0.55 + seededRand(seed + 2) * 0.22) * (CHUNK_LENGTH / 5);
      const x = side * (5.95 + seededRand(seed + 3) * 0.45);

      const lampGroup = new THREE.Group();
      group.add(lampGroup);

      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.13, height, 8),
        lampPoleMaterial,
      );
      pole.castShadow = true;
      lampGroup.add(pole);

      const centerYOffset = height / 2;

      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.12, 0.9),
        lampPoleMaterial,
      );
      arm.position.set(0, height - 0.38 - centerYOffset, side * -0.36);
      arm.castShadow = true;
      lampGroup.add(arm);

      const lampHead = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.18, 0.24),
        lampHeadMaterial,
      );
      lampHead.position.set(0, height - 0.42 - centerYOffset, side * -0.78);
      lampHead.castShadow = true;
      lampGroup.add(lampHead);

      const lampGlow = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 8),
        lampGlowMaterial,
      );
      lampGlow.position.set(0, height - 0.5 - centerYOffset, side * -0.78);
      lampGroup.add(lampGlow);

      const body = ctx.world.createRigidBody(
        ctx.RAPIER.RigidBodyDesc.fixed().setTranslation(x, height / 2, z),
      );
      const collider = ctx.world.createCollider(
        ctx.RAPIER.ColliderDesc.cuboid(0.12, height / 2, 0.12)
          .setFriction(0.64)
          .setRestitution(0.02),
        body,
      );

      lampPosts.push({
        group: lampGroup,
        body,
        collider,
        toppled: false,
        baseX: x,
        baseZ: z,
        height,
        side,
      });
    }

    return lampPosts;
  };

  const terrainColliderHandles = new Set<number>();

  const roadMaterial = new THREE.MeshStandardMaterial({
    color: 0x43484d,
    roughness: 0.94,
    metalness: 0.04,
  });
  const shoulderMaterial = new THREE.MeshStandardMaterial({
    color: 0x76a85b,
    roughness: 1,
    metalness: 0,
  });

  const makeChunk = (chunkIndex: number): ChunkData => {
    const group = new THREE.Group();
    group.name = `chunk-${chunkIndex}`;

    const terrainTiles = createTerrainTilesForChunk({
      ctx,
      group,
      chunkIndex,
      roadMaterial,
      shoulderMaterial,
      terrainColliderHandles,
    });

    const buildings = buildingSystem.createBuildingsForChunk(chunkIndex, group);
    const lampPosts = createLampPostsForChunk(group, chunkIndex);
    addRoadsideGreenery(group, chunkIndex);

    scene.add(group);
    return { group, terrainTiles, buildings, lampPosts };
  };

  const removeChunk = (chunk: ChunkData) => {
    scene.remove(chunk.group);
    removeTerrainTiles(ctx, chunk.terrainTiles, terrainColliderHandles);
    buildingSystem.removeBuildings(chunk.buildings);
    for (const lampPost of chunk.lampPosts) {
      ctx.world.removeRigidBody(lampPost.body);
    }
    disposeGroupMeshes(chunk.group);
  };

  const toppleLampPostsNear = (carPosition: { x: number; y: number; z: number }, quakeAmplitude: number) => {
    for (const chunk of manager.loadedChunks.values()) {
      for (const lampPost of chunk.lampPosts) {
        if (lampPost.toppled) continue;

        const dx = lampPost.baseX - carPosition.x;
        const dz = lampPost.baseZ - carPosition.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 32) continue;
        if (dz > 14) continue;

        lampPost.toppled = true;
        setBodyTypeDynamic(ctx, lampPost.body);

        const towardRoad = -lampPost.side;
        const topPoint = {
          x: lampPost.baseX,
          y: lampPost.height,
          z: lampPost.baseZ,
        };
        const push = 120 + quakeAmplitude * 520;
        lampPost.body.applyImpulseAtPoint(
          {
            x: towardRoad * push,
            y: 26 + quakeAmplitude * 80,
            z: (seededRand(Math.round(lampPost.baseZ * 10)) - 0.5) * 30,
          },
          topPoint,
          true,
        );
        lampPost.body.setAngvel(
          {
            x: (seededRand(Math.round(lampPost.baseX * 100) + 3) - 0.5) * 0.8,
            y: (seededRand(Math.round(lampPost.baseZ * 100) + 7) - 0.5) * 0.6,
            z: -towardRoad * (2.2 + quakeAmplitude * 2.4),
          },
          true,
        );
      }
    }
  };

  const syncLampPostVisuals = () => {
    for (const chunk of manager.loadedChunks.values()) {
      for (const lampPost of chunk.lampPosts) {
        copyRigidBodyToObject3D(lampPost.body, lampPost.group);
      }
    }
  };

  const manager = createChunkManager<ChunkData>({
    makeChunk,
    removeChunk,
  });

  const dispose = () => {
    manager.dispose();
    roadMaterial.dispose();
    shoulderMaterial.dispose();
    lampPoleMaterial.dispose();
    lampHeadMaterial.dispose();
    lampGlowMaterial.dispose();
  };

  return {
    loadedChunks: manager.loadedChunks,
    terrainColliderHandles,
    syncChunks: manager.syncChunks,
    toppleLampPostsNear,
    syncLampPostVisuals,
    dispose,
  };
}

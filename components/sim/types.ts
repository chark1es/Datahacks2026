import type { Collider, RigidBody } from "@dimforge/rapier3d-compat";
import type * as THREE from "three";

export type QuakeUi = {
  magnitudeMw: number;
  targetMw: number;
};

export type TimelineUi = {
  month: number;
  year: number;
  monthKey: string;
  targetMagnitude: number;
};

export type ProgressUi = {
  progress01: number;
  remainingMonths: number;
  remainingPercent: number;
};

export type FaultEvent = {
  originX: number;
  originZ: number;
  dirX: number;
  dirZ: number;
  normalX: number;
  normalZ: number;
  length: number;
  split: number;
  drop: number;
  width: number;
  progress: number;
  speed: number;
};

export type PersistedBuildingState = {
  isCollapsed: boolean;
  collapseDirection: -1 | 1;
  scatterSeed: number;
};

export type TerrainTileData = {
  mesh: THREE.Mesh;
  body: RigidBody;
  collider: Collider;
  baseX: number;
  baseZ: number;
  phase: number;
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotZ: number;
};

export type BuildingChunkData = {
  mesh: THREE.Mesh;
  body: RigidBody;
  collider: Collider;
  localOffset: THREE.Vector3;
  detached: boolean;
  halfExtents: THREE.Vector3;
};

export type BuildingData = {
  key: string;
  anchorBody: RigidBody;
  chunks: BuildingChunkData[];
  baseX: number;
  baseZ: number;
  width: number;
  depth: number;
  height: number;
  isCollapsed: boolean;
};

export type LampPostData = {
  group: THREE.Group;
  body: RigidBody;
  collider: Collider;
  toppled: boolean;
  baseX: number;
  baseZ: number;
  height: number;
  side: -1 | 1;
};

export type ChunkData = {
  group: THREE.Group;
  terrainTiles: TerrainTileData[];
  buildings: BuildingData[];
  lampPosts: LampPostData[];
};

export type ActiveQuake = {
  scenarioIndex: number;
  elapsed: number;
  duration: number;
  amplitude: number;
  frequencyHz: number;
  magnitudeMw: number;
};

export type WorldDamageState = {
  maxTier: 0 | 1 | 2 | 3;
  tier1Applied: boolean;
  tier2Applied: boolean;
  tier3Events: number;
};

import * as THREE from "three";
import { CHUNK_LENGTH } from "@/components/sim/constants";

export function seededRand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function disposeGroupMeshes(group: THREE.Object3D) {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((mat) => mat.dispose());
    } else {
      mesh.material?.dispose();
    }
  });
}

export function uvFromWorld(x: number, z: number): { u: number; v: number } {
  const u = Math.min(1, Math.max(0, (x + 12) / 24));
  const cycle = CHUNK_LENGTH * 6;
  const v = ((((z / cycle) % 1) + 1) % 1 + 0.15) % 1;
  return { u, v };
}

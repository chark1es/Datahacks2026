import RAPIER from "@dimforge/rapier3d-compat";
import type { RigidBody } from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { PHYSICS_FIXED_STEP } from "@/components/sim/constants";

let rapierInitPromise: Promise<typeof RAPIER> | null = null;

export type RapierApi = typeof RAPIER;

export type PhysicsContext = {
  RAPIER: RapierApi;
  world: RAPIER.World;
  eventQueue: RAPIER.EventQueue;
};

export async function ensureRapierInitialized(): Promise<RapierApi> {
  if (!rapierInitPromise) {
    rapierInitPromise = (async () => {
      await RAPIER.init();
      return RAPIER;
    })();
  }
  return rapierInitPromise;
}

export function createPhysicsContext(R: RapierApi): PhysicsContext {
  const world = new R.World({ x: 0, y: -9.82, z: 0 });
  world.timestep = PHYSICS_FIXED_STEP;
  const eventQueue = new R.EventQueue(true);
  return { RAPIER: R, world, eventQueue };
}

export function disposePhysicsContext(ctx: PhysicsContext) {
  ctx.eventQueue.free();
  ctx.world.free();
}

export function copyRigidBodyToObject3D(body: RigidBody, obj: THREE.Object3D) {
  const p = body.translation();
  const q = body.rotation();
  obj.position.set(p.x, p.y, p.z);
  obj.quaternion.set(q.x, q.y, q.z, q.w);
}

export function toInteractionGroups(memberships: number, filters: number): number {
  return ((memberships & 0xffff) << 16) | (filters & 0xffff);
}

export function setBodyTypeDynamic(ctx: PhysicsContext, body: RigidBody) {
  body.setBodyType(ctx.RAPIER.RigidBodyType.Dynamic, true);
  body.wakeUp();
}

export function setBodyTypeFixed(ctx: PhysicsContext, body: RigidBody) {
  body.setBodyType(ctx.RAPIER.RigidBodyType.Fixed, true);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

export function setBodyTypeKinematic(ctx: PhysicsContext, body: RigidBody) {
  body.setBodyType(ctx.RAPIER.RigidBodyType.KinematicPositionBased, true);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

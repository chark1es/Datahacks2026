import * as THREE from "three";
import type { Collider, RigidBody } from "@dimforge/rapier3d-compat";
import {
  CAR_WHEEL_RAYCAST_DOWN,
  CAR_WHEEL_RAYCAST_UP,
  DEFAULT_MEMBERSHIP,
  MAX_WHEEL_STEER_ANGLE,
  PHYSICS_FIXED_STEP,
  TERRAIN_MEMBERSHIP,
  WHEEL_RADIUS,
  WHEEL_STEER_LERP,
  WORLD_HALF_X,
} from "@/components/sim/constants";
import { copyRigidBodyToObject3D, toInteractionGroups } from "@/components/sim/physics";
import type { PhysicsContext } from "@/components/sim/physics";
import type { ActiveQuake } from "@/components/sim/types";

type WheelVisual = {
  steerPivot: THREE.Group;
  spinGroup: THREE.Group;
  isFront: boolean;
};

export type CarActor = {
  group: THREE.Group;
  body: RigidBody;
  colliders: Collider[];
  colliderHandles: Set<number>;
  updateControls: (
    simTime: number,
    activeQuake: ActiveQuake | null,
    terrainColliderHandles: Set<number>,
  ) => void;
  updateVisuals: (dt: number) => void;
  dispose: () => void;
};

const ALL_GROUPS = 0xffff;
const CAR_COLLISION_FILTERS = ALL_GROUPS & ~TERRAIN_MEMBERSHIP;
const CAR_MOVE_HALF_EXTENTS = { x: 0.92, y: 0.62, z: 1.82 };
const CAR_MOVE_CENTER_Y = 0.72;
const CAR_MOVE_SKIN = 0.05;
const CAR_SUPPORT_LERP = 0.22;
const CAR_MAX_SPEED = 15.5;
const CAR_MAX_REVERSE_SPEED = 6.2;
const CAR_ACCEL = 26;
const CAR_REVERSE_ACCEL = 10;
const CAR_BRAKE_DECEL = 24;
const CAR_COAST_DECEL = 7.5;
const CAR_STEER_RATE = 1.85;
const CAR_SUPPORT_RAY_START = CAR_WHEEL_RAYCAST_UP + 0.5;
const CAR_SUPPORT_RAY_LENGTH = CAR_WHEEL_RAYCAST_UP + CAR_WHEEL_RAYCAST_DOWN + 1.6;

export function createCarActor(ctx: PhysicsContext, scene: THREE.Scene): CarActor {
  const car = new THREE.Group();
  scene.add(car);

  const bodyMaterialVisual = new THREE.MeshStandardMaterial({
    color: 0xd24f3f,
    roughness: 0.42,
    metalness: 0.34,
  });
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x9ac7df,
    roughness: 0.12,
    metalness: 0.5,
    transparent: true,
    opacity: 0.78,
  });
  const wheelMaterial = new THREE.MeshStandardMaterial({
    color: 0x181a1f,
    roughness: 0.86,
    metalness: 0.12,
  });
  const rimMaterial = new THREE.MeshStandardMaterial({
    color: 0xadb7c6,
    roughness: 0.32,
    metalness: 0.84,
  });

  const lowerBodyMesh = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 3.6), bodyMaterialVisual);
  lowerBodyMesh.position.set(0, 0.52, 0);
  lowerBodyMesh.castShadow = true;
  car.add(lowerBodyMesh);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.52, 1.8), bodyMaterialVisual);
  cabin.position.set(0, 1.05, -0.1);
  cabin.castShadow = true;
  car.add(cabin);

  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.36, 0.08), glassMaterial);
  windshield.position.set(0, 1.07, 0.72);
  windshield.rotation.x = -0.58;
  car.add(windshield);

  const rearGlass = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.3, 0.08), glassMaterial);
  rearGlass.position.set(0, 1.02, -0.93);
  rearGlass.rotation.x = 0.46;
  car.add(rearGlass);

  const sideWindowGeo = new THREE.BoxGeometry(0.07, 0.3, 0.88);
  const leftWindow = new THREE.Mesh(sideWindowGeo, glassMaterial);
  leftWindow.position.set(-0.68, 1.02, -0.05);
  car.add(leftWindow);
  const rightWindow = new THREE.Mesh(sideWindowGeo, glassMaterial);
  rightWindow.position.set(0.68, 1.02, -0.05);
  car.add(rightWindow);

  const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.28, 22);
  const rimGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.3, 16);
  const wheelVisuals: WheelVisual[] = [];
  const wheelLocalPoints: THREE.Vector3[] = [];
  let wheelSpinAngle = 0;
  let wheelSteerAngle = 0;
  let visualForwardSpeed = 0;

  const wheelPositions: [number, number, number][] = [
    [-0.85, 0.34, 1.2],
    [0.85, 0.34, 1.2],
    [-0.85, 0.34, -1.2],
    [0.85, 0.34, -1.2],
  ];

  wheelPositions.forEach(([x, y, z]) => {
    const isFront = z < 0;
    wheelLocalPoints.push(new THREE.Vector3(x, y, z));

    const steerPivot = new THREE.Group();
    steerPivot.position.set(x, y, z);
    car.add(steerPivot);

    const spinGroup = new THREE.Group();
    steerPivot.add(spinGroup);

    const wheel = new THREE.Mesh(wheelGeo, wheelMaterial);
    wheel.rotation.z = Math.PI / 2;
    wheel.castShadow = true;
    spinGroup.add(wheel);

    const rim = new THREE.Mesh(rimGeo, rimMaterial);
    rim.rotation.z = Math.PI / 2;
    spinGroup.add(rim);

    wheelVisuals.push({ steerPivot, spinGroup, isFront });
  });

  const wheelSupportOffset = WHEEL_RADIUS - wheelLocalPoints[0].y;
  const bodyDesc = ctx.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, wheelSupportOffset + 0.02, 0);
  const body = ctx.world.createRigidBody(bodyDesc);

  const colliders: Collider[] = [];

  const addCarCollider = (desc: import("@dimforge/rapier3d-compat").ColliderDesc) => {
    desc
      .setFriction(0.12)
      .setRestitution(0.02)
      .setActiveEvents(ctx.RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setCollisionGroups(toInteractionGroups(DEFAULT_MEMBERSHIP, CAR_COLLISION_FILTERS));
    const collider = ctx.world.createCollider(desc, body);
    colliders.push(collider);
  };

  addCarCollider(ctx.RAPIER.ColliderDesc.cuboid(0.95, 0.24, 1.8).setTranslation(0, 0.48, 0));
  addCarCollider(ctx.RAPIER.ColliderDesc.cuboid(0.75, 0.18, 1.1).setTranslation(0, 0.86, -0.08));
  addCarCollider(ctx.RAPIER.ColliderDesc.cuboid(0.72, 0.08, 1.2).setTranslation(0, 0.2, 0));

  const colliderHandles = new Set(colliders.map((collider) => collider.handle));

  const keys = { w: false, s: false, a: false, d: false };
  const onKey = (event: KeyboardEvent, down: boolean) => {
    const key = event.code;
    let handled = false;
    if (key === "KeyW" || key === "ArrowUp") {
      keys.w = down;
      handled = true;
    }
    if (key === "KeyS" || key === "ArrowDown") {
      keys.s = down;
      handled = true;
    }
    if (key === "KeyA" || key === "ArrowLeft") {
      keys.a = down;
      handled = true;
    }
    if (key === "KeyD" || key === "ArrowRight") {
      keys.d = down;
      handled = true;
    }
    if (!handled) return;
    event.preventDefault();
    if (down) body.wakeUp();
  };

  const onKeyDown = (event: KeyboardEvent) => onKey(event, true);
  const onKeyUp = (event: KeyboardEvent) => onKey(event, false);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const moveShape = new ctx.RAPIER.Cuboid(CAR_MOVE_HALF_EXTENTS.x, CAR_MOVE_HALF_EXTENTS.y, CAR_MOVE_HALF_EXTENTS.z);
  const position = new THREE.Vector3();
  const nextPosition = new THREE.Vector3();
  const desiredMove = new THREE.Vector3();
  const resolvedMove = new THREE.Vector3();
  const moveShapeCenter = new THREE.Vector3();
  const wheelWorld = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const lateral = new THREE.Vector3();
  const yawQuat = new THREE.Quaternion();
  const yawEuler = new THREE.Euler();

  let yaw = 0;
  let forwardSpeed = 0;

  const resolvePlanarMove = (
    currentPosition: THREE.Vector3,
    desiredDelta: THREE.Vector3,
    rotation: THREE.Quaternion,
    terrainColliderHandles: Set<number>,
  ): THREE.Vector3 => {
    resolvedMove.copy(desiredDelta);
    const distance = desiredDelta.length();

    if (distance <= 1e-6) {
      return resolvedMove.set(0, 0, 0);
    }

    moveShapeCenter.set(currentPosition.x, currentPosition.y + CAR_MOVE_CENTER_Y, currentPosition.z);
    const hit = ctx.world.castShape(
      { x: moveShapeCenter.x, y: moveShapeCenter.y, z: moveShapeCenter.z },
      { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      { x: desiredDelta.x, y: 0, z: desiredDelta.z },
      moveShape,
      0,
      1,
      false,
      ctx.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      body,
      (collider) => !terrainColliderHandles.has(collider.handle),
    );

    if (hit) {
      const allowed = Math.max(0, hit.time_of_impact - CAR_MOVE_SKIN / distance);
      resolvedMove.multiplyScalar(allowed);
    }

    return resolvedMove;
  };

  const sampleSupportHeight = (
    supportPosition: THREE.Vector3,
    rotation: THREE.Quaternion,
    terrainColliderHandles: Set<number>,
  ): number => {
    let maxHitY = -Infinity;

    for (const wheelPoint of wheelLocalPoints) {
      wheelWorld.copy(wheelPoint).applyQuaternion(rotation).add(supportPosition);
      const originY = wheelWorld.y + CAR_SUPPORT_RAY_START;
      const ray = new ctx.RAPIER.Ray(
        { x: wheelWorld.x, y: originY, z: wheelWorld.z },
        { x: 0, y: -1, z: 0 },
      );
      const hit = ctx.world.castRayAndGetNormal(
        ray,
        CAR_SUPPORT_RAY_LENGTH,
        true,
        ctx.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        body,
        (collider) => terrainColliderHandles.has(collider.handle),
      );

      if (!hit || !terrainColliderHandles.has(hit.collider.handle)) {
        continue;
      }

      const hitY = originY - hit.timeOfImpact;
      if (hitY > maxHitY) {
        maxHitY = hitY;
      }
    }

    return maxHitY;
  };

  const updateControls = (
    simTime: number,
    activeQuake: ActiveQuake | null,
    terrainColliderHandles: Set<number>,
  ) => {
    const translation = body.translation();
    position.set(translation.x, translation.y, translation.z);

    const throttle = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
    const steer = (keys.a ? 1 : 0) - (keys.d ? 1 : 0);

    if (throttle > 0) {
      if (forwardSpeed < 0) {
        forwardSpeed = Math.min(0, forwardSpeed + CAR_BRAKE_DECEL * PHYSICS_FIXED_STEP);
      } else {
        forwardSpeed = Math.min(CAR_MAX_SPEED, forwardSpeed + CAR_ACCEL * PHYSICS_FIXED_STEP);
      }
    } else if (throttle < 0) {
      if (forwardSpeed > 0) {
        forwardSpeed = Math.max(0, forwardSpeed - CAR_BRAKE_DECEL * PHYSICS_FIXED_STEP);
      } else {
        forwardSpeed = Math.max(-CAR_MAX_REVERSE_SPEED, forwardSpeed - CAR_REVERSE_ACCEL * PHYSICS_FIXED_STEP);
      }
    } else if (forwardSpeed !== 0) {
      const coast = Math.min(Math.abs(forwardSpeed), CAR_COAST_DECEL * PHYSICS_FIXED_STEP);
      forwardSpeed -= Math.sign(forwardSpeed) * coast;
    }

    const steerStrength = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / CAR_MAX_SPEED, 0.2, 1);
    if (Math.abs(forwardSpeed) > 0.05 && steer !== 0) {
      yaw +=
        steer *
        CAR_STEER_RATE *
        steerStrength *
        Math.sign(forwardSpeed) *
        PHYSICS_FIXED_STEP;
    }

    yawEuler.set(0, yaw, 0);
    yawQuat.setFromEuler(yawEuler);
    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    lateral.set(forward.z, 0, -forward.x);
    desiredMove.copy(forward).multiplyScalar(forwardSpeed * PHYSICS_FIXED_STEP);

    if (activeQuake) {
      const fade = Math.max(0, 1 - activeQuake.elapsed / activeQuake.duration);
      const shake = Math.sin(simTime * activeQuake.frequencyHz * Math.PI * 2) * activeQuake.amplitude * fade * 0.09;
      desiredMove.addScaledVector(lateral, shake);
    }

    resolvePlanarMove(position, desiredMove, yawQuat, terrainColliderHandles);
    nextPosition.copy(position).add(resolvedMove);
    nextPosition.x = THREE.MathUtils.clamp(nextPosition.x, -WORLD_HALF_X + 0.6, WORLD_HALF_X - 0.6);

    const actualMoveDistance =
      (nextPosition.x - position.x) * forward.x +
      (nextPosition.z - position.z) * forward.z;
    visualForwardSpeed = actualMoveDistance / PHYSICS_FIXED_STEP;
    if (Math.abs(visualForwardSpeed) < Math.abs(forwardSpeed)) {
      forwardSpeed = visualForwardSpeed;
    }

    const supportHeight = sampleSupportHeight(nextPosition, yawQuat, terrainColliderHandles);
    const targetY = Number.isFinite(supportHeight) ? supportHeight + wheelSupportOffset : position.y;
    nextPosition.y = THREE.MathUtils.lerp(position.y, targetY, CAR_SUPPORT_LERP);

    body.setNextKinematicTranslation({ x: nextPosition.x, y: nextPosition.y, z: nextPosition.z });
    body.setNextKinematicRotation({ x: yawQuat.x, y: yawQuat.y, z: yawQuat.z, w: yawQuat.w });

    if (nextPosition.y < -8) {
      forwardSpeed = 0;
      body.setTranslation({ x: 0, y: wheelSupportOffset + 0.02, z: nextPosition.z }, true);
      body.setNextKinematicTranslation({ x: 0, y: wheelSupportOffset + 0.02, z: nextPosition.z });
    }
  };

  const updateVisuals = (dt: number) => {
    copyRigidBodyToObject3D(body, car);

    wheelSpinAngle += (visualForwardSpeed / WHEEL_RADIUS) * dt;

    const steerInput = (keys.a ? 1 : 0) - (keys.d ? 1 : 0);
    const targetWheelSteer = -steerInput * MAX_WHEEL_STEER_ANGLE;
    wheelSteerAngle = THREE.MathUtils.lerp(
      wheelSteerAngle,
      targetWheelSteer,
      Math.min(1, dt * WHEEL_STEER_LERP),
    );

    for (const wheel of wheelVisuals) {
      wheel.steerPivot.rotation.y = wheel.isFront ? wheelSteerAngle : 0;
      wheel.spinGroup.rotation.x = wheelSpinAngle;
    }
  };

  const dispose = () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);

    scene.remove(car);
    ctx.world.removeRigidBody(body);

    car.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((mat) => mat.dispose());
      } else {
        mesh.material?.dispose();
      }
    });
  };

  return {
    group: car,
    body,
    colliders,
    colliderHandles,
    updateControls,
    updateVisuals,
    dispose,
  };
}

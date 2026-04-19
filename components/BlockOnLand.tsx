"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  estimateMagnitudeMw,
  loadPgvDataset,
  maxPgvForScenario,
  pgvMsForMagnitudeMw,
  samplePgvBilinear,
  scenarioParamsAt,
  type PgvManifest,
  type ScenarioParams,
} from "@/lib/pgv";
import {
  loadMonthlyMagnitudeTimeline,
  timelineMonthAtDistance,
  type MonthlyMagnitudePoint,
} from "@/lib/quakeTimeline";
import { computeTimelineProgress } from "@/lib/seismicDamage";
import {
  CAMERA_DISTANCE,
  CAMERA_HEIGHT,
  CAMERA_LERP,
  CAMERA_LOOK_AHEAD,
  CAMERA_MOUSE_FOLLOW_SPEED,
  CAMERA_MOUSE_MAX_PITCH,
  CAMERA_MOUSE_MAX_YAW,
  CAMERA_MOUSE_PITCH_SENSITIVITY,
  CAMERA_MOUSE_RETURN_SPEED,
  CAMERA_MOUSE_YAW_SENSITIVITY,
  COLLISION_COOLDOWN,
  HUD_UPDATE_INTERVAL,
  PHYSICS_FIXED_STEP,
  QUAKE_DURATION,
  TIMELINE_UNITS_PER_MONTH,
} from "@/components/sim/constants";
import {
  createPhysicsContext,
  disposePhysicsContext,
  ensureRapierInitialized,
} from "@/components/sim/physics";
import { uvFromWorld } from "@/components/sim/utils";
import { createCarActor } from "@/components/sim/entities/car";
import { createBuildingSystem } from "@/components/sim/entities/buildings";
import { createWorldChunksSystem } from "@/components/sim/systems/worldChunks";
import { createDamageSystem } from "@/components/sim/systems/damageSystem";
import { updateTerrainKinematics } from "@/components/sim/entities/terrain";
import { createCollisionSystem } from "@/components/sim/systems/collisionSystem";
import type { ActiveQuake, ProgressUi, QuakeUi, TimelineUi } from "@/components/sim/types";

export default function BlockOnLand() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [quakeUi, setQuakeUi] = useState<QuakeUi | null>(null);
  const [timelineUi, setTimelineUi] = useState<TimelineUi | null>(null);
  const [progressUi, setProgressUi] = useState<ProgressUi | null>(null);
  const [gameStarted, setGameStarted] = useState(false);
  const [gameCompleted, setGameCompleted] = useState(false);
  const [endingPhase, setEndingPhase] = useState<"idle" | "cinematic" | "impact" | "message">("idle");
  const [restartToken, setRestartToken] = useState(0);
  const gameCompletedRef = useRef(false);
  gameCompletedRef.current = gameCompleted;
  const timelineMonthKeyRef = useRef<string>("");
  const autoTriggeredMonthKeyRef = useRef<string>("");

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let rafId = 0;
    let teardown: (() => void) | null = null;
    let isDisposed = false;

    const run = async () => {
      const RAPIER = await ensureRapierInitialized();
      if (isDisposed) return;

      const scene = new THREE.Scene();
      const skyColor = new THREE.Color(0x8fcdf7);
      const fogColor = new THREE.Color(0xcfe8f6);
      const horizonColor = new THREE.Color(0xf4d3a1);
      const sunDayColor = new THREE.Color(0xfff7ea);
      const tempColor = new THREE.Color();
      const tempColor2 = new THREE.Color();
      const backgroundColor = skyColor.clone();
      scene.background = backgroundColor;
      scene.fog = new THREE.Fog(fogColor.getHex(), 36, 210);

      const camera = new THREE.PerspectiveCamera(
        55,
        mount.clientWidth / Math.max(mount.clientHeight, 1),
        0.1,
        400,
      );

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      mount.appendChild(renderer.domElement);

      const ambient = new THREE.AmbientLight(0xf3efe3, 0.72);
      scene.add(ambient);

      const skyLight = new THREE.HemisphereLight(0xbfe2ff, 0x6a8f52, 0.82);
      scene.add(skyLight);

      const sun = new THREE.DirectionalLight(0xfff4db, 1.35);
      sun.position.set(14, 22, 10);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near = 0.5;
      sun.shadow.camera.far = 220;
      sun.shadow.camera.left = -52;
      sun.shadow.camera.right = 52;
      sun.shadow.camera.top = 52;
      sun.shadow.camera.bottom = -52;
      scene.add(sun);

      const farFloorMaterial = new THREE.MeshStandardMaterial({
        color: 0x94be74,
        roughness: 1,
        metalness: 0,
      });
      const farFloor = new THREE.Mesh(
        new THREE.PlaneGeometry(420, 900),
        farFloorMaterial,
      );
      farFloor.rotation.x = -Math.PI / 2;
      farFloor.position.y = -3.8;
      farFloor.receiveShadow = true;
      scene.add(farFloor);

      const physics = createPhysicsContext(RAPIER);
      const buildingSystem = createBuildingSystem(physics);
      const worldChunks = createWorldChunksSystem({
        scene,
        ctx: physics,
        buildingSystem,
      });
      const car = createCarActor(physics, scene);
      const damageSystem = createDamageSystem({
        scheduleCollapsesNearCar: buildingSystem.scheduleCollapsesNearCar,
      });
      const collisionSystem = createCollisionSystem({
        eventQueue: physics.eventQueue,
        carColliderHandles: car.colliderHandles,
        buildingColliderHandles: buildingSystem.buildingBaseColliderHandles,
      });

      worldChunks.syncChunks(car.body.translation().z);

      const clock = new THREE.Clock();
      const desiredCamPos = new THREE.Vector3();
      const lookTarget = new THREE.Vector3();
      const orbitForward = new THREE.Vector3();
      const orbitRight = new THREE.Vector3();
      const orbitOffset = new THREE.Vector3();
      const worldUp3 = new THREE.Vector3(0, 1, 0);
      const endLookTarget = new THREE.Vector3();
      const meteorTarget = new THREE.Vector3();
      const impactTarget = new THREE.Vector3();
      const impactOffset = new THREE.Vector3();
      const endCamFrom = new THREE.Vector3();
      const endCamTo = new THREE.Vector3();
      const endLookFrom = new THREE.Vector3();
      const endLookTo = new THREE.Vector3();
      const explosionGroup = new THREE.Group();
      const explosionShellScale = new THREE.Vector3(1, 1, 1);
      const explosionRingScale = new THREE.Vector3(1, 1, 1);
      const meteorCore = new THREE.Group();
      const meteorDisposables: Array<THREE.BufferGeometry | THREE.Material> = [];
      const registerMeteorMesh = (mesh: THREE.Mesh) => {
        meteorDisposables.push(mesh.geometry as THREE.BufferGeometry);
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((material) => meteorDisposables.push(material));
        } else {
          meteorDisposables.push(mesh.material);
        }
        meteorCore.add(mesh);
        return mesh;
      };

      const meteorShellMaterial = new THREE.MeshStandardMaterial({
        color: 0x5a4636,
        emissive: 0x30150b,
        emissiveIntensity: 0.55,
        roughness: 1,
        metalness: 0.04,
      });
      const meteorShell = registerMeteorMesh(
        new THREE.Mesh(new THREE.DodecahedronGeometry(2.55, 0), meteorShellMaterial),
      );
      meteorShell.castShadow = true;
      meteorShell.scale.set(1.18, 0.9, 0.8);

      const meteorCrustMaterial = new THREE.MeshStandardMaterial({
        color: 0x261912,
        emissive: 0x140804,
        emissiveIntensity: 0.45,
        roughness: 0.98,
        metalness: 0.02,
      });
      const meteorCrust = registerMeteorMesh(
        new THREE.Mesh(new THREE.IcosahedronGeometry(2.02, 1), meteorCrustMaterial),
      );
      meteorCrust.castShadow = true;
      meteorCrust.scale.set(1.04, 0.8, 0.72);
      meteorCrust.rotation.set(0.5, 0.2, -0.35);

      const meteorEmberMaterial = new THREE.MeshStandardMaterial({
        color: 0xff9c52,
        emissive: 0xff6724,
        emissiveIntensity: 1.9,
        roughness: 0.58,
        metalness: 0.03,
        transparent: true,
        opacity: 0.92,
      });
      const meteorEmberShell = registerMeteorMesh(
        new THREE.Mesh(new THREE.IcosahedronGeometry(1.9, 1), meteorEmberMaterial),
      );
      meteorEmberShell.scale.set(0.96, 0.74, 0.66);
      meteorEmberShell.rotation.set(0.2, -0.35, 0.15);

      const meteorWakeOuterMaterial = new THREE.MeshStandardMaterial({
        color: 0xffb869,
        emissive: 0xff7d2d,
        emissiveIntensity: 2.1,
        roughness: 0.84,
        metalness: 0.01,
        transparent: true,
        opacity: 0.68,
      });
      const meteorWakeOuter = registerMeteorMesh(
        new THREE.Mesh(new THREE.SphereGeometry(1.42, 22, 18), meteorWakeOuterMaterial),
      );
      meteorWakeOuter.position.set(0, 0.2, -3.8);
      meteorWakeOuter.scale.set(1.35, 1.1, 3.6);

      const meteorWakeInnerMaterial = new THREE.MeshStandardMaterial({
        color: 0xffe2a2,
        emissive: 0xffbc58,
        emissiveIntensity: 2.4,
        roughness: 0.34,
        metalness: 0.01,
        transparent: true,
        opacity: 0.8,
      });
      const meteorWakeInner = registerMeteorMesh(
        new THREE.Mesh(new THREE.SphereGeometry(0.9, 18, 16), meteorWakeInnerMaterial),
      );
      meteorWakeInner.position.set(0, 0.1, -3.15);
      meteorWakeInner.scale.set(0.9, 0.85, 2.85);

      const meteorSmokeMaterial = new THREE.MeshStandardMaterial({
        color: 0x3d281d,
        emissive: 0x2d1006,
        emissiveIntensity: 0.32,
        roughness: 1,
        metalness: 0,
        transparent: true,
        opacity: 0.3,
      });
      const meteorSmoke = registerMeteorMesh(
        new THREE.Mesh(new THREE.SphereGeometry(1.8, 18, 14), meteorSmokeMaterial),
      );
      meteorSmoke.position.set(0, 0.45, -5.6);
      meteorSmoke.scale.set(1.7, 1.2, 2.9);

      const meteorFragments: THREE.Mesh[] = [];
      for (let i = 0; i < 5; i += 1) {
        const fragment = registerMeteorMesh(
          new THREE.Mesh(
            new THREE.DodecahedronGeometry(0.35 + i * 0.07, 0),
            i % 2 === 0 ? meteorShellMaterial : meteorCrustMaterial,
          ),
        );
        const yaw = (i / 5) * Math.PI * 2 + 0.35;
        const radius = 1.3 + (i % 2) * 0.45;
        fragment.position.set(Math.cos(yaw) * radius, (i - 2) * 0.22, Math.sin(yaw) * 0.55);
        fragment.scale.set(1.2, 0.85, 0.95);
        fragment.castShadow = true;
        meteorFragments.push(fragment);
      }

      meteorCore.visible = false;
      scene.add(meteorCore);

      const impactFlash = new THREE.PointLight(0xff8c52, 0, 70, 2);
      impactFlash.visible = false;
      scene.add(impactFlash);

      const explosionShell = new THREE.Mesh(
        new THREE.SphereGeometry(2.8, 24, 24),
        new THREE.MeshStandardMaterial({
          color: 0xffb86b,
          emissive: 0xff6b2f,
          emissiveIntensity: 1.6,
          roughness: 0.45,
          metalness: 0.02,
          transparent: true,
          opacity: 0,
        }),
      );
      const explosionCore = new THREE.Mesh(
        new THREE.SphereGeometry(1.5, 20, 20),
        new THREE.MeshStandardMaterial({
          color: 0xfff1be,
          emissive: 0xffd37a,
          emissiveIntensity: 2.1,
          roughness: 0.2,
          metalness: 0.01,
          transparent: true,
          opacity: 0,
        }),
      );
      const explosionRing = new THREE.Mesh(
        new THREE.TorusGeometry(3.6, 0.42, 18, 48),
        new THREE.MeshStandardMaterial({
          color: 0xff9a52,
          emissive: 0xff6129,
          emissiveIntensity: 1.5,
          roughness: 0.58,
          metalness: 0.04,
          transparent: true,
          opacity: 0,
        }),
      );
      explosionRing.rotation.x = Math.PI / 2;
      explosionGroup.visible = false;
      explosionGroup.add(explosionShell);
      explosionGroup.add(explosionCore);
      explosionGroup.add(explosionRing);
      scene.add(explosionGroup);

      let mouseOrbitActive = false;
      let mouseOrbitPointerId = -1;
      let mouseLastX = 0;
      let mouseLastY = 0;
      let mouseOrbitYaw = 0;
      let mouseOrbitPitch = 0;
      let mouseOrbitYawTarget = 0;
      let mouseOrbitPitchTarget = 0;
      const endingShortcutKeys = { o: false, p: false };

      const onPointerDown = (event: PointerEvent) => {
        if (gameCompletedRef.current) return;
        if (event.button !== 0 && event.button !== 2) return;
        mouseOrbitActive = true;
        mouseOrbitPointerId = event.pointerId;
        mouseLastX = event.clientX;
        mouseLastY = event.clientY;
        renderer.domElement.setPointerCapture(event.pointerId);
        event.preventDefault();
      };

      const onPointerMove = (event: PointerEvent) => {
        if (gameCompletedRef.current) return;
        if (!mouseOrbitActive || event.pointerId !== mouseOrbitPointerId) return;
        const dx = event.clientX - mouseLastX;
        const dy = event.clientY - mouseLastY;
        mouseLastX = event.clientX;
        mouseLastY = event.clientY;

        mouseOrbitYawTarget = THREE.MathUtils.clamp(
          mouseOrbitYawTarget - dx * CAMERA_MOUSE_YAW_SENSITIVITY,
          -CAMERA_MOUSE_MAX_YAW,
          CAMERA_MOUSE_MAX_YAW,
        );
        mouseOrbitPitchTarget = THREE.MathUtils.clamp(
          mouseOrbitPitchTarget - dy * CAMERA_MOUSE_PITCH_SENSITIVITY,
          -CAMERA_MOUSE_MAX_PITCH,
          CAMERA_MOUSE_MAX_PITCH,
        );

        event.preventDefault();
      };

      const onPointerUp = (event: PointerEvent) => {
        if (!mouseOrbitActive || event.pointerId !== mouseOrbitPointerId) return;
        mouseOrbitActive = false;
        mouseOrbitPointerId = -1;
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
      };

      const onCanvasContextMenu = (event: MouseEvent) => {
        event.preventDefault();
      };

      const onEndingShortcutKey = (event: KeyboardEvent, down: boolean) => {
        if (event.repeat) return;

        if (event.code === "KeyO") {
          endingShortcutKeys.o = down;
        } else if (event.code === "KeyP") {
          endingShortcutKeys.p = down;
        } else {
          return;
        }

        if (down && gameStarted && !gameCompletedRef.current && endingShortcutKeys.o && endingShortcutKeys.p) {
          event.preventDefault();
          startEndingSequence();
          return;
        }

        if (down) {
          event.preventDefault();
        }
      };

      const onEndingShortcutKeyDown = (event: KeyboardEvent) => onEndingShortcutKey(event, true);
      const onEndingShortcutKeyUp = (event: KeyboardEvent) => onEndingShortcutKey(event, false);

      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      renderer.domElement.addEventListener("contextmenu", onCanvasContextMenu);
      window.addEventListener("keydown", onEndingShortcutKeyDown);
      window.addEventListener("keyup", onEndingShortcutKeyUp);

      let pgvData: Float32Array | null = null;
      let pgvManifest: PgvManifest | null = null;
      let pgvCount = 0;
      let pgvManifestMax = 1;
      let scenarioParams: number[][] | null = null;
      let monthTimeline: MonthlyMagnitudePoint[] = [];

      void loadPgvDataset()
        .then(({ manifest, data, params }) => {
          pgvData = data;
          pgvManifest = manifest;
          pgvCount = manifest.count;
          pgvManifestMax = Math.max(manifest.globalMax, 1e-6);
          scenarioParams = params;
        })
        .catch((err: unknown) => {
          console.error("Failed to load PGV dataset", err);
        });

      void loadMonthlyMagnitudeTimeline("/data/SOCAL_EQ_MAG3.csv")
        .then((timeline) => {
          monthTimeline = timeline;
        })
        .catch((err: unknown) => {
          console.error("Failed to load magnitude timeline CSV", err);
        });

      let activeQuake: ActiveQuake | null = null;
      let collisionCooldown = 0;
      let collisionLock = false;
      let hudElapsed = 0;
      let progressCache: ProgressUi | null = null;
      let simTime = 0;
      let physicsAccumulator = 0;
      let endingSequenceStarted = false;
      let endingElapsed = 0;
      let impactTriggered = false;
      let impactBlastTriggered = false;
      let endingPhaseState: "idle" | "cinematic" | "impact" | "message" = "idle";

      const updateEndingPhase = (phase: "idle" | "cinematic" | "impact" | "message") => {
        if (endingPhaseState === phase) return;
        endingPhaseState = phase;
        setEndingPhase(phase);
      };

      const startEndingSequence = () => {
        if (endingSequenceStarted) return;
        endingSequenceStarted = true;
        endingElapsed = 0;
        impactTriggered = false;
        impactBlastTriggered = false;
        gameCompletedRef.current = true;
        car.setControlsEnabled(false);
        mouseOrbitActive = false;
        mouseOrbitPointerId = -1;
        updateEndingPhase("cinematic");
        setGameCompleted(true);
      };

      const sampleScenarioPgvAtCar = (scenarioIndex: number): number => {
        if (!pgvData || pgvCount <= 0 || scenarioIndex < 0 || scenarioIndex >= pgvCount || !pgvManifest) {
          return 0;
        }
        const carPos = car.body.translation();
        const uv = uvFromWorld(carPos.x, carPos.z);
        return samplePgvBilinear(pgvData, pgvManifest, scenarioIndex, uv.u, uv.v);
      };

      const triggerQuake = (
        scenarioIndex: number,
        pgvMs: number,
        params: ScenarioParams | null,
        targetMw: number,
      ) => {
        const magnitudeMw = estimateMagnitudeMw(pgvMs, params);
        const pgvNormalized = Math.min(1, pgvMs / pgvManifestMax);
        const intensityScale = THREE.MathUtils.clamp(0.25 + pgvNormalized * 1.35, 0.2, 1.5);

        activeQuake = {
          scenarioIndex,
          elapsed: 0,
          duration: QUAKE_DURATION,
          amplitude: 0.18 * intensityScale,
          frequencyHz: 3.2 + pgvNormalized * 7.5,
          magnitudeMw,
        };

        setQuakeUi({ magnitudeMw, targetMw });
        damageSystem.applyMagnitudeDamage(magnitudeMw, simTime, car.body);
      };

      const triggerScaledMonthQuake = (scenarioIndex: number, targetMw: number) => {
        if (targetMw <= 0) {
          setQuakeUi({ magnitudeMw: 0, targetMw: 0 });
          return;
        }
        if (!pgvData || !pgvManifest || pgvCount <= 0) return;
        const sIdx = ((scenarioIndex % pgvCount) + pgvCount) % pgvCount;
        const scenarioMax = maxPgvForScenario(pgvData, pgvManifest, sIdx);
        const localPgv = sampleScenarioPgvAtCar(sIdx);
        const rawPgvMs = Math.max(localPgv, scenarioMax * 0.58);
        const params = scenarioParamsAt(scenarioParams, sIdx);
        const targetPgvMs = pgvMsForMagnitudeMw(targetMw, params);
        const scale = targetPgvMs / Math.max(rawPgvMs, 1e-6);
        const scaledPgvMs = rawPgvMs * scale;

        triggerQuake(sIdx, scaledPgvMs, params, targetMw);
      };

      const tick = () => {
        const dt = Math.min(clock.getDelta(), 1 / 20);
        hudElapsed += dt;
        if (gameStarted && !gameCompletedRef.current) {
          physicsAccumulator += dt;
        }

        if (collisionCooldown > 0) {
          collisionCooldown = Math.max(0, collisionCooldown - dt);
        }

        const carPosition = car.body.translation();
        const forwardDistance = Math.max(0, -carPosition.z);
        const timelineIndex = Math.max(0, Math.floor(forwardDistance / TIMELINE_UNITS_PER_MONTH));
        const activeMonth = timelineMonthAtDistance(forwardDistance, TIMELINE_UNITS_PER_MONTH, monthTimeline);

        if (activeMonth && timelineMonthKeyRef.current !== activeMonth.monthKey) {
          timelineMonthKeyRef.current = activeMonth.monthKey;
          setTimelineUi({
            month: activeMonth.month,
            year: activeMonth.year,
            monthKey: activeMonth.monthKey,
            targetMagnitude: activeMonth.targetMagnitude,
          });
        }

        const timelineProgress = computeTimelineProgress(
          forwardDistance,
          TIMELINE_UNITS_PER_MONTH,
          monthTimeline.length,
        );

        if (!gameCompletedRef.current && monthTimeline.length > 0 && timelineProgress.progress01 >= 1) {
          startEndingSequence();
        }

        const lightPhase = 0.5 + 0.5 * Math.sin(forwardDistance / 95);
        const warmthPhase = 0.5 + 0.5 * Math.sin(forwardDistance / 72 + 0.8);
        tempColor.copy(horizonColor).lerp(skyColor, lightPhase);
        backgroundColor.copy(tempColor);
        tempColor2.copy(fogColor).lerp(horizonColor, 1 - lightPhase);
        (scene.fog as THREE.Fog).color.copy(tempColor2);
        ambient.intensity = THREE.MathUtils.lerp(0.62, 0.9, lightPhase);
        skyLight.intensity = THREE.MathUtils.lerp(0.68, 1.02, lightPhase);
        skyLight.color.copy(tempColor);
        skyLight.groundColor.setHSL(0.24 + warmthPhase * 0.04, 0.34, 0.34 + lightPhase * 0.08);
        sun.intensity = THREE.MathUtils.lerp(1.0, 1.55, lightPhase);
        sun.color.copy(horizonColor).lerp(sunDayColor, lightPhase);
        sun.position.set(
          THREE.MathUtils.lerp(-18, 20, lightPhase),
          THREE.MathUtils.lerp(14, 26, lightPhase),
          8 + Math.sin(forwardDistance / 110) * 6,
        );
        farFloorMaterial.color.setHSL(0.24 + lightPhase * 0.06, 0.36, 0.48 + lightPhase * 0.08);

        if (hudElapsed >= HUD_UPDATE_INTERVAL) {
          hudElapsed = 0;
          const nextProgress: ProgressUi = {
            progress01: timelineProgress.progress01,
            remainingMonths: timelineProgress.remainingMonths,
            remainingPercent: (1 - timelineProgress.progress01) * 100,
          };

          const changed =
            !progressCache ||
            Math.abs(progressCache.progress01 - nextProgress.progress01) > 0.004 ||
            progressCache.remainingMonths !== nextProgress.remainingMonths;

          if (changed) {
            progressCache = nextProgress;
            setProgressUi(nextProgress);
          }
        }

        if (
          gameStarted &&
          activeMonth &&
          activeMonth.monthKey !== autoTriggeredMonthKeyRef.current &&
          pgvCount > 0 &&
          pgvData &&
          pgvManifest
        ) {
          autoTriggeredMonthKeyRef.current = activeMonth.monthKey;
          triggerScaledMonthQuake(timelineIndex, activeMonth.targetMagnitude);
        }

        while (gameStarted && !gameCompletedRef.current && physicsAccumulator >= PHYSICS_FIXED_STEP) {
          simTime += PHYSICS_FIXED_STEP;

          buildingSystem.processPendingDamage(simTime, car.body);
          worldChunks.syncChunks(car.body.translation().z);
          updateTerrainKinematics(
            worldChunks.loadedChunks.values(),
            PHYSICS_FIXED_STEP,
            simTime,
            damageSystem.faultEvents,
            damageSystem.worldDamage,
          );
          buildingSystem.syncAttachedTopChunks();
          if (activeQuake) {
            worldChunks.toppleLampPostsNear(car.body.translation(), activeQuake.amplitude);
          }
          car.updateControls(simTime, activeQuake, worldChunks.terrainColliderHandles);

          physics.world.step(physics.eventQueue);

          const hitBuilding = collisionSystem.consumeCarBuildingHit();

          if (hitBuilding) {
            if (!collisionLock && collisionCooldown <= 0 && pgvCount > 0 && pgvData && pgvManifest) {
              const scenarioIndex = Math.floor(Math.random() * pgvCount);
              const targetMw = activeMonth?.targetMagnitude ?? 4.5;
              triggerScaledMonthQuake(scenarioIndex, targetMw);
              collisionLock = true;
              collisionCooldown = COLLISION_COOLDOWN;
            }
          } else {
            collisionLock = false;
          }

          physicsAccumulator -= PHYSICS_FIXED_STEP;
        }

        if (activeQuake) {
          activeQuake.elapsed += dt;
          if (activeQuake.elapsed >= activeQuake.duration) {
            activeQuake = null;
          }
        }

        buildingSystem.syncVisualsFromPhysics();
        worldChunks.syncLampPostVisuals();
        car.updateVisuals(dt);

        const carForward = new THREE.Vector3(0, 0, -1).applyQuaternion(car.group.quaternion);
        carForward.y = 0;
        if (carForward.lengthSq() < 1e-6) {
          carForward.set(0, 0, -1);
        } else {
          carForward.normalize();
        }

        if (!gameCompletedRef.current && !mouseOrbitActive) {
          mouseOrbitYawTarget = THREE.MathUtils.lerp(
            mouseOrbitYawTarget,
            0,
            Math.min(1, dt * CAMERA_MOUSE_RETURN_SPEED),
          );
          mouseOrbitPitchTarget = THREE.MathUtils.lerp(
            mouseOrbitPitchTarget,
            0,
            Math.min(1, dt * CAMERA_MOUSE_RETURN_SPEED),
          );
        }

        if (gameCompletedRef.current && endingSequenceStarted) {
          endingElapsed += dt;

          const cinematicProgress = THREE.MathUtils.clamp(endingElapsed / 2.2, 0, 1);
          const easedCinematic = 1 - Math.pow(1 - cinematicProgress, 3);
          impactTarget.copy(car.group.position);
          impactTarget.y = 0.3;

          endCamFrom.copy(car.group.position).add(new THREE.Vector3(-10, 9.5, 24));
          endCamTo.copy(car.group.position).add(new THREE.Vector3(18, 14, 26));
          desiredCamPos.copy(endCamFrom).lerp(endCamTo, easedCinematic);
          camera.position.lerp(desiredCamPos, 0.08);

          endLookFrom.copy(car.group.position).add(new THREE.Vector3(0, 2.2, -13));
          endLookTo.copy(impactTarget).add(new THREE.Vector3(0.5, 3.6, -1.5));
          endLookTarget.copy(endLookFrom).lerp(endLookTo, easedCinematic);
          camera.lookAt(endLookTarget);
          camera.rotation.z = THREE.MathUtils.lerp(camera.rotation.z, -0.08, 0.08);

          meteorCore.visible = true;
          meteorCore.rotation.x += dt * 2.4;
          meteorCore.rotation.y += dt * 1.7;
          meteorTarget.copy(impactTarget);
          impactOffset.set(-36, 30, -22).multiplyScalar(1 - Math.min(endingElapsed / 2.35, 1));
          meteorCore.position.copy(meteorTarget).add(impactOffset);
          meteorCore.lookAt(impactTarget);
          const meteorPulse = 0.92 + Math.sin(endingElapsed * 24) * 0.08;
          meteorEmberMaterial.emissiveIntensity = 1.7 + meteorPulse * 0.7;
          meteorWakeOuterMaterial.emissiveIntensity = 1.8 + meteorPulse * 0.9;
          meteorWakeInnerMaterial.emissiveIntensity = 2 + meteorPulse * 1.1;
          meteorWakeOuter.scale.set(1.35 + meteorPulse * 0.12, 1.08 + meteorPulse * 0.08, 3.4 + meteorPulse * 0.75);
          meteorWakeInner.scale.set(0.88 + meteorPulse * 0.08, 0.8 + meteorPulse * 0.08, 2.7 + meteorPulse * 0.55);
          meteorSmoke.scale.set(1.6 + meteorPulse * 0.2, 1.15 + meteorPulse * 0.1, 2.8 + meteorPulse * 0.45);
          meteorFragments.forEach((fragment, idx) => {
            fragment.rotation.x += dt * (0.8 + idx * 0.1);
            fragment.rotation.y -= dt * (1.2 + idx * 0.12);
          });

          if (!impactTriggered && endingElapsed >= 2.15) {
            impactTriggered = true;
            updateEndingPhase("impact");
          }

          if (impactTriggered) {
            if (!impactBlastTriggered) {
              impactBlastTriggered = true;
              buildingSystem.blastBuildingsFromPoint(impactTarget, 42, 2.4);
            }
            meteorCore.visible = false;
            impactFlash.visible = true;
            impactFlash.position.copy(impactTarget).add(new THREE.Vector3(0, 3.5, 0));
            const flashT = endingElapsed - 2.15;
            impactFlash.intensity = Math.max(0, 11 - flashT * 12);
            tempColor.copy(backgroundColor).lerp(new THREE.Color(0x090909), THREE.MathUtils.clamp(flashT / 1.1, 0, 1));
            backgroundColor.copy(tempColor);
            (scene.fog as THREE.Fog).color.lerp(new THREE.Color(0x090909), Math.min(1, dt * 2.4));
            ambient.intensity = THREE.MathUtils.lerp(ambient.intensity, 0.08, Math.min(1, dt * 2.2));
            skyLight.intensity = THREE.MathUtils.lerp(skyLight.intensity, 0.06, Math.min(1, dt * 2.2));
            sun.intensity = THREE.MathUtils.lerp(sun.intensity, 0.12, Math.min(1, dt * 2.2));

            explosionGroup.visible = flashT <= 1.2;
            explosionGroup.position.copy(impactTarget).add(new THREE.Vector3(0, 1.1, 0));
            const shellMaterial = explosionShell.material as THREE.MeshStandardMaterial;
            const coreMaterial = explosionCore.material as THREE.MeshStandardMaterial;
            const ringMaterial = explosionRing.material as THREE.MeshStandardMaterial;
            const shellScale = 1 + flashT * 7.2;
            const coreScale = 1 + flashT * 4.8;
            const ringScale = 1 + flashT * 5.9;

            explosionShellScale.setScalar(shellScale);
            explosionRingScale.set(ringScale, ringScale, Math.max(0.35, 1 - flashT * 0.42));
            explosionShell.scale.copy(explosionShellScale);
            explosionCore.scale.setScalar(coreScale);
            explosionRing.scale.copy(explosionRingScale);
            explosionRing.rotation.z += dt * 1.8;

            shellMaterial.opacity = Math.max(0, 0.82 - flashT * 0.72);
            coreMaterial.opacity = Math.max(0, 0.96 - flashT * 1.05);
            ringMaterial.opacity = Math.max(0, 0.74 - flashT * 0.62);
          } else {
            impactFlash.visible = false;
            explosionGroup.visible = false;
          }

          if (endingElapsed >= 3.3) {
            updateEndingPhase("message");
          }
        } else {
          mouseOrbitYaw = THREE.MathUtils.lerp(
            mouseOrbitYaw,
            mouseOrbitYawTarget,
            Math.min(1, dt * CAMERA_MOUSE_FOLLOW_SPEED),
          );
          mouseOrbitPitch = THREE.MathUtils.lerp(
            mouseOrbitPitch,
            mouseOrbitPitchTarget,
            Math.min(1, dt * CAMERA_MOUSE_FOLLOW_SPEED),
          );

          orbitForward.copy(carForward).applyAxisAngle(worldUp3, mouseOrbitYaw);
          if (orbitForward.lengthSq() < 1e-6) {
            orbitForward.set(0, 0, -1);
          } else {
            orbitForward.normalize();
          }

          orbitRight.crossVectors(worldUp3, orbitForward);
          if (orbitRight.lengthSq() > 1e-6) {
            orbitRight.normalize();
          } else {
            orbitRight.set(1, 0, 0);
          }

          orbitOffset.copy(orbitForward).multiplyScalar(-CAMERA_DISTANCE);
          orbitOffset.y += CAMERA_HEIGHT;
          orbitOffset.applyAxisAngle(orbitRight, mouseOrbitPitch);
          desiredCamPos.copy(car.group.position).add(orbitOffset);

          if (activeQuake) {
            const t = activeQuake.elapsed;
            const fade = Math.max(0, 1 - t / activeQuake.duration);
            const s1 = Math.sin(activeQuake.frequencyHz * Math.PI * 2 * t);
            const s2 = Math.sin(activeQuake.frequencyHz * Math.PI * 1.46 * t + 0.75);
            desiredCamPos.x += s1 * activeQuake.amplitude * fade * 1.1;
            desiredCamPos.z += s2 * activeQuake.amplitude * fade * 0.95;
            camera.rotation.z = s2 * activeQuake.amplitude * fade * 0.08;
          } else {
            camera.rotation.z = 0;
          }

          camera.position.lerp(desiredCamPos, CAMERA_LERP);
          lookTarget.copy(car.group.position).addScaledVector(orbitForward, CAMERA_LOOK_AHEAD);
          lookTarget.y += 0.8;
          camera.lookAt(lookTarget);
          meteorCore.visible = false;
          impactFlash.visible = false;
          explosionGroup.visible = false;
        }

        renderer.render(scene, camera);
      };

      const loop = () => {
        rafId = requestAnimationFrame(loop);
        tick();
      };
      loop();

      const onResize = () => {
        const w = mount.clientWidth;
        const h = Math.max(mount.clientHeight, 1);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener("resize", onResize);

      teardown = () => {
        cancelAnimationFrame(rafId);

        window.removeEventListener("resize", onResize);
        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer.domElement.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        renderer.domElement.removeEventListener("contextmenu", onCanvasContextMenu);
        window.removeEventListener("keydown", onEndingShortcutKeyDown);
        window.removeEventListener("keyup", onEndingShortcutKeyUp);

        worldChunks.dispose();
        car.dispose();
        scene.remove(meteorCore);
        meteorDisposables.forEach((item) => item.dispose());
        scene.remove(impactFlash);
        scene.remove(explosionGroup);
        explosionShell.geometry.dispose();
        (explosionShell.material as THREE.Material).dispose();
        explosionCore.geometry.dispose();
        (explosionCore.material as THREE.Material).dispose();
        explosionRing.geometry.dispose();
        (explosionRing.material as THREE.Material).dispose();

        scene.remove(farFloor);
        farFloor.geometry.dispose();
        farFloorMaterial.dispose();

        if (mount.contains(renderer.domElement)) {
          mount.removeChild(renderer.domElement);
        }
        renderer.dispose();

        disposePhysicsContext(physics);
      };

      if (isDisposed && teardown) {
        teardown();
      }
    };

    void run();

    return () => {
      isDisposed = true;
      if (teardown) {
        teardown();
      }
    };
  }, [gameStarted, restartToken]);

  const handleRestart = () => {
    timelineMonthKeyRef.current = "";
    autoTriggeredMonthKeyRef.current = "";
    setQuakeUi(null);
    setTimelineUi(null);
    setProgressUi(null);
    setGameCompleted(false);
    setEndingPhase("idle");
    setRestartToken((value) => value + 1);
  };

  const handleStart = () => {
    timelineMonthKeyRef.current = "";
    autoTriggeredMonthKeyRef.current = "";
    setQuakeUi(null);
    setTimelineUi(null);
    setProgressUi(null);
    setGameCompleted(false);
    setEndingPhase("idle");
    setGameStarted(true);
    setRestartToken((value) => value + 1);
  };

  return (
    <div ref={mountRef} className="relative h-dvh w-full">
      {!gameStarted && (
        <div className="absolute inset-0 z-40 bg-white/50 backdrop-blur-[4px]">
          <div className="relative flex h-full items-center justify-center px-6 py-10">
            <div className="w-full max-w-3xl rounded-2xl border border-black/10 bg-[color:oklch(0.985_0.006_98)] p-7 text-[color:oklch(0.24_0.02_240)] shadow-[0_20px_48px_rgba(15,23,42,0.1)] sm:p-8">
              <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-end">
                <div>
                  <p className="font-[family-name:var(--font-display)] text-sm font-medium tracking-tight text-[color:oklch(0.42_0.025_240)]">
                    The Quake Driver
                  </p>
                  <h1 className="mt-2 max-w-xl font-[family-name:var(--font-display)] text-[1.65rem] font-semibold leading-[1.15] tracking-[-0.02em] text-[color:oklch(0.2_0.02_240)] sm:text-3xl">
                    Drive the seismic record.
                  </h1>
                  <p className="mt-4 max-w-xl font-[family-name:var(--font-body)] text-sm leading-relaxed text-[color:oklch(0.44_0.02_240)]">
                    The road is a month-by-month earthquake timeline for Southern California. Drive forward to advance
                    through the dataset, feel each triggered quake, and keep the lane clear long enough to survive the
                    full run.
                  </p>
                  <p className="mt-5 max-w-xl text-xs leading-6 text-[color:oklch(0.48_0.02_240)]">
                    Dataset-driven motion · obstacle avoidance · month-by-month progression
                  </p>
                </div>
                <div className="rounded-xl border border-black/8 bg-[color:oklch(0.995_0.004_98)] p-5">
                  <p className="font-[family-name:var(--font-display)] text-xs font-medium uppercase tracking-[0.14em] text-[color:oklch(0.46_0.02_240)]">
                    Instructions
                  </p>
                  <div className="mt-4 space-y-3 text-sm text-[color:oklch(0.44_0.02_240)]">
                    <div className="flex items-start justify-between gap-4 border-b border-black/8 pb-3">
                      <span className="text-[color:oklch(0.24_0.02_240)]">Drive</span>
                      <span className="font-[family-name:var(--font-display)] text-[13px] text-[color:oklch(0.4_0.08_200)]">
                        WASD / arrows
                      </span>
                    </div>
                    <div className="flex items-start justify-between gap-4 border-b border-black/8 pb-3">
                      <span className="text-[color:oklch(0.24_0.02_240)]">Look</span>
                      <span className="font-[family-name:var(--font-display)] text-[13px] text-[color:oklch(0.4_0.08_200)]">
                        Drag to orbit
                      </span>
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <span className="text-[color:oklch(0.24_0.02_240)]">Goal</span>
                      <span className="max-w-[12rem] text-right text-[color:oklch(0.48_0.02_240)]">
                        Keep moving; avoid debris as each month activates.
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleStart}
                    className="mt-6 w-full pointer-events-auto rounded-lg border border-[color:var(--accent)]/40 bg-[color:var(--accent)] px-5 py-2.5 font-[family-name:var(--font-display)] text-sm font-medium tracking-wide text-[color:var(--surface-deep)] transition-colors hover:brightness-[0.96]"
                  >
                    Start run
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {gameStarted && gameCompleted && (
        <div
          className={`absolute inset-0 z-40 px-6 transition-all duration-[1400ms] ${
            endingPhase === "message"
              ? "bg-black/100"
              : endingPhase === "impact"
                ? "bg-black/70 backdrop-blur-sm"
                : "bg-black/10"
          }`}
        >
          <div className="flex h-full items-center justify-center">
            <div
              className={`max-w-2xl text-center text-white transition-all duration-700 ${
                endingPhase === "message"
                  ? "translate-y-0 opacity-100"
                  : "translate-y-6 opacity-0"
              }`}
            >
              <p className="font-[family-name:var(--font-display)] text-[0.72rem] font-semibold uppercase tracking-[0.42em] text-white/55">
                Final Impact
              </p>
              <h2 className="mt-5 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">
                Thanks for playing our game
              </h2>
              <button
                type="button"
                onClick={handleRestart}
                className="mt-8 pointer-events-auto rounded-xl border border-white/20 bg-white/10 px-6 py-3 text-sm font-bold tracking-[0.14em] text-white transition-colors hover:bg-white/16"
              >
                Restart Run
              </button>
            </div>
          </div>
        </div>
      )}

      {gameStarted && !gameCompleted && (
        <div className="absolute bottom-5 left-1/2 z-30 -translate-x-1/2">
          <button
            type="button"
            onClick={handleRestart}
            className="pointer-events-auto rounded-xl border border-red-200/55 bg-[color:var(--danger)] px-6 py-3 text-sm font-bold tracking-[0.14em] text-white shadow-[0_12px_28px_rgba(120,20,10,0.35)] transition-colors hover:bg-[#d85a45]"
          >
            Restart Run
          </button>
        </div>
      )}

      <div
        className={`pointer-events-none absolute left-4 right-4 top-3 z-20 rounded-md border border-white/20 bg-black/55 px-3 py-2 text-[11px] text-white backdrop-blur-sm transition-opacity duration-500 ${
          gameCompleted ? "opacity-0" : "opacity-100"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 font-semibold tracking-wide">
          <span>
            {timelineUi
              ? `Month ${String(timelineUi.month).padStart(2, "0")}/${timelineUi.year}`
              : "Month --/----"}
          </span>
          <span>{Math.round((progressUi?.progress01 ?? 0) * 100)}% complete</span>
          <span>
            {progressUi
              ? `${progressUi.remainingMonths} months left (${Math.round(progressUi.remainingPercent)}%)`
              : "-- months left"}
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/20">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200"
            style={{ width: `${((progressUi?.progress01 ?? 0) * 100).toFixed(1)}%` }}
          />
        </div>
      </div>

      <div
        className={`pointer-events-none absolute left-4 top-20 z-10 rounded-md border border-white/20 bg-black/45 p-3 text-xs text-white backdrop-blur-sm transition-opacity duration-500 ${
          gameCompleted ? "opacity-0" : "opacity-100"
        }`}
      >
        <p className="font-semibold tracking-wide">
          Month/Year: {timelineUi ? `${String(timelineUi.month).padStart(2, "0")}/${timelineUi.year}` : "--/----"}
        </p>
        <p className="font-semibold tracking-wide">
          CSV Target: {timelineUi ? timelineUi.targetMagnitude.toFixed(2) : "--"}
        </p>
        <p className="font-semibold tracking-wide">
          Magnitude: {quakeUi ? quakeUi.magnitudeMw.toFixed(2) : "--"}
        </p>
      </div>
    </div>
  );
}

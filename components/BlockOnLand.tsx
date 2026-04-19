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
  const [restartToken, setRestartToken] = useState(0);
  const timelineMonthKeyRef = useRef<string>("");
  const autoTriggeredMonthKeyRef = useRef<string>("");

  useEffect(() => {
    if (!gameStarted) return;

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
        scheduleTopBreaksNearCar: buildingSystem.scheduleTopBreaksNearCar,
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

      let mouseOrbitActive = false;
      let mouseOrbitPointerId = -1;
      let mouseLastX = 0;
      let mouseLastY = 0;
      let mouseOrbitYaw = 0;
      let mouseOrbitPitch = 0;
      let mouseOrbitYawTarget = 0;
      let mouseOrbitPitchTarget = 0;

      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0 && event.button !== 2) return;
        mouseOrbitActive = true;
        mouseOrbitPointerId = event.pointerId;
        mouseLastX = event.clientX;
        mouseLastY = event.clientY;
        renderer.domElement.setPointerCapture(event.pointerId);
        event.preventDefault();
      };

      const onPointerMove = (event: PointerEvent) => {
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

      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      renderer.domElement.addEventListener("contextmenu", onCanvasContextMenu);

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
        physicsAccumulator += dt;

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

        if (!gameCompleted && monthTimeline.length > 0 && timelineProgress.progress01 >= 1) {
          setGameCompleted(true);
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
          activeMonth &&
          activeMonth.monthKey !== autoTriggeredMonthKeyRef.current &&
          pgvCount > 0 &&
          pgvData &&
          pgvManifest
        ) {
          autoTriggeredMonthKeyRef.current = activeMonth.monthKey;
          triggerScaledMonthQuake(timelineIndex, activeMonth.targetMagnitude);
        }

        while (physicsAccumulator >= PHYSICS_FIXED_STEP) {
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

        if (!mouseOrbitActive) {
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

        worldChunks.dispose();
        car.dispose();

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
    setRestartToken((value) => value + 1);
  };

  const handleStart = () => {
    timelineMonthKeyRef.current = "";
    autoTriggeredMonthKeyRef.current = "";
    setQuakeUi(null);
    setTimelineUi(null);
    setProgressUi(null);
    setGameCompleted(false);
    setGameStarted(true);
    setRestartToken((value) => value + 1);
  };

  return (
    <div ref={mountRef} className="relative h-dvh w-full">
      {!gameStarted && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-[linear-gradient(180deg,rgba(130,197,240,0.92),rgba(241,210,153,0.88)_44%,rgba(124,174,101,0.92))] px-6">
          <div className="max-w-xl rounded-2xl border border-white/45 bg-black/28 p-7 text-white shadow-[0_24px_80px_rgba(0,0,0,0.24)] backdrop-blur-md">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-white/78">Fault Run</p>
            <h1 className="mt-3 text-3xl font-black tracking-tight text-white">Drive the quake timeline.</h1>
            <p className="mt-4 text-sm leading-6 text-white/88">
              Welcome. You are about to drive through 26 years of seismic history in Southern California, where your
              movement forward advances time and the world around you responds to real earthquake events recorded by
              the USGS and enhanced with scientific ground motion simulations. As you travel, you will experience how
              the environment changes based on actual seismic activity, shifts in intensity, frequency, and impact,
              creating a data-driven reconstruction of how the Earth truly moved over time. This is not a fictional
              scenario, but a visualization of real events, allowing you to observe and experience earthquakes as they
              unfolded. Drive forward to begin the timeline.
            </p>
            <p className="mt-4 text-sm leading-6 text-white/88">
              Buildings and lamp posts can collapse into the street as the earthquake magnitude rises. Stay moving,
              avoid barriers, and drive through the month-by-month timeline.
            </p>
            <div className="mt-5 space-y-2 text-sm text-white/86">
              <p>`WASD` or arrow keys to steer and drive.</p>
              <p>Collisions can trigger the next quake event.</p>
              <p>Use mouse drag to orbit the camera while driving.</p>
            </div>
            <button
              type="button"
              onClick={handleStart}
              className="mt-7 pointer-events-auto rounded-xl border border-white/35 bg-[var(--accent)] px-6 py-3 text-base font-bold tracking-wide text-black transition-transform hover:scale-[1.02]"
            >
              Start Game
            </button>
          </div>
        </div>
      )}

      {gameStarted && gameCompleted && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/42 px-6 backdrop-blur-sm">
          <div className="max-w-lg rounded-2xl border border-white/30 bg-[linear-gradient(180deg,rgba(20,36,28,0.88),rgba(25,25,35,0.88))] p-8 text-center text-white shadow-[0_24px_80px_rgba(0,0,0,0.32)]">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-white/65">Timeline Complete</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight">Congratulations.</h2>
            <p className="mt-4 text-base leading-7 text-white/88">
              You survived all the earthquakes and made it through the full Southern California seismic timeline.
            </p>
            <button
              type="button"
              onClick={handleRestart}
              className="mt-7 pointer-events-auto rounded-xl border border-red-200/55 bg-[color:var(--danger)] px-6 py-3 text-sm font-bold tracking-[0.14em] text-white shadow-[0_12px_28px_rgba(120,20,10,0.35)] transition-colors hover:bg-[#d85a45]"
            >
              Restart Run
            </button>
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

      <div className="pointer-events-none absolute left-4 right-4 top-3 z-20 rounded-md border border-white/20 bg-black/55 px-3 py-2 text-[11px] text-white backdrop-blur-sm">
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

      <div className="pointer-events-none absolute left-4 top-20 z-10 rounded-md border border-white/20 bg-black/45 p-3 text-xs text-white backdrop-blur-sm">
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

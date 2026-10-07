/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * record-present-gate.test.ts: The observeState recordPresent gate during the removal grace. When a device is unadopted at the controller, its config record leaves the
 * store but its ProtectDevice wrapper lingers for the DelayDeviceRemoval grace. The gate (if(!this.recordPresent) continue) keeps every observe loop subscribed while
 * suppressing its handler, so an async-void capability handler never re-reads the vanished record and throws into the detached loop, and a re-adoption within the grace
 * resumes the handlers with no respawn. This drives a REAL ProtectCamera against the camera-construction harness doubles, as capability-reconcile.test.ts does, and is
 * SELF-VALIDATING: the positive liveness control (a present-record push reconciles and creates the sensor) proves the counter and the observer are live, so the
 * suppression assertion that follows cannot pass for the wrong reason. The global unhandledRejection channel and a loopFaultReporter spy are deliberately NOT consulted.
 *
 * The suite also nets the occurrence replay guard that rides on the gate: the removal wake the gate drops leaves the store's last-yielded value undefined, so a record
 * returning within the grace yields its unchanged slices as "changes". An occurrence slice (the camera's lastMotion) must not replay the stamp it left with as a
 * fresh detection, while a level slice (camera.state) must still re-read live state on the return. Every suppression assertion is paired with a liveness control in
 * the same test - a later stamp still fires - so the guard is proven to skip the replay rather than kill the loop.
 */
import type { Camera, ProtectCameraConfig } from "unifi-protect";
import { Characteristic, Service, TestCameraProjection, TestRecordingDispatch, TestStateStore, makeCameraConfig, makeProtectState, makeTestAccessory, makeTestNvr,
  settle } from "../../testing.helpers.ts";
import type { TestAccessory, TestProtectNvr } from "../../testing.helpers.ts";
import { describe, test } from "node:test";
import { G2_PRO_CHANNELS } from "../../camera.fixtures.ts";
import type { ProtectAccessory } from "../../types.ts";
import { ProtectCamera } from "./camera.ts";
import type { ProtectEventDispatch } from "../../nvr/event-dispatch.ts";
import type { ProtectNvr } from "../../nvr/nvr.ts";
import assert from "node:assert/strict";

// A ProtectCamera that counts its reconcileCapabilities invocations, so the test proves the async-void capability observer is LIVE (the count rises on a present-record
// push, alongside the service that reconcile creates) and then SUPPRESSED once the record vanishes (the count holds). Construction's own reconcile is wiped from this
// counter by the subclass field-define (the field initializes to 0 after super returns), so the count measures the live observer's invocations from a 0 baseline.
class CountingCamera extends ProtectCamera {

  public reconcileCount = 0;

  protected override async reconcileCapabilities(source: "construct" | "observe"): Promise<void> {

    this.reconcileCount++;

    return super.reconcileCapabilities(source);
  }
}

// Construct a real CountingCamera, with the casts confined to this one seam - the instance under test is the production class and its real observe loops.
function construct(nvr: TestProtectNvr, accessory: TestAccessory, projection: TestCameraProjection): CountingCamera {

  return new CountingCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory, projection as unknown as Camera);
}

describe("the observeState recordPresent gate during the removal grace", () => {

  test("an async-void capability observer reconciles while the record is present and is suppressed once it vanishes (self-validating)", async () => {

    // A camera adopted WITHOUT the lux capability, so the ambient light sensor is absent at adoption - its later appearance is the observable proof the observer ran.
    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS, featureFlags: { hasLuxCheck: false } });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:record-present-gate-1");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // The baseline after construction (the construct reconcile is wiped from the counter by the subclass field-define), and the camera's full set of observe loops.
      const baseline = camera.reconcileCount;
      const observerCount = store.observerCount;

      assert.ok(observerCount > 0, "the camera spawned its observe loops");
      assert.equal(accessory.getService(Service.LightSensor), undefined, "no ambient light sensor exists before the present-record push (the vacuity guard)");

      // Positive liveness control: a featureFlags push with the record PRESENT wakes the async-void capability observer, which invokes reconcileCapabilities and creates
      // the ambient light sensor. The count rising AND the service appearing prove the observer is live and the counter records its invocations.
      store.pushCameraFeatureFlags(cameraConfig.id, { hasLuxCheck: true });

      await settle();

      assert.ok(camera.reconcileCount > baseline, "the present-record featureFlags push invoked reconcileCapabilities - the async-void observer is live");
      assert.ok(accessory.getService(Service.LightSensor), "the present-record reconcile created the ambient light sensor");

      const afterPresentPush = camera.reconcileCount;

      // The record vanishes (the camera unadopted, lingering in the removal grace). The removal wakes every observer (their slices go undefined), but the recordPresent
      // gate (continue) suppresses each handler before it runs: the async-void capability observer does NOT invoke reconcileCapabilities (so it cannot throw into the
      // detached loop), and every observe loop stays subscribed rather than dying - so a re-adoption within the grace resumes the handlers with no respawn.
      store.removeCameraRecord(cameraConfig.id);

      await settle();

      assert.equal(camera.reconcileCount, afterPresentPush,
        "the recordPresent gate suppressed the async-void capability observer once the record vanished - reconcileCapabilities was not invoked");
      assert.equal(store.observerCount, observerCount,
        "every observe loop stayed subscribed across the vanished record (continue, not break) so a re-adoption resumes them - the survival " +
        "invariant (the reconcileCount assertion above is the gate's discriminator)");
    } finally {

      camera.cleanup();
    }
  });

  // #17/G2-D1: the camera capability getters read the throwing ufp projection, and the reconcile pass reads them on every kick - including after an await where the
  // record can vanish. Hardened through fromRecord, they must report safe defaults over a vanished record rather than throwing. Pre-fix the raw ufp read threw
  // ReferenceError, which the supervisor's reconcile pass then floated through its many fire-and-forget kicks.
  test("the camera capability getters return safe defaults over a vanished record instead of throwing", async () => {

    const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
    const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));
    const { nvr } = makeTestNvr({ store });
    const accessory = makeTestAccessory("Test Camera", "uuid:record-present-gate-getters");
    const camera = construct(nvr, accessory, new TestCameraProjection(cameraConfig.id, store));

    await settle();

    try {

      // With the record present, the getters read through the live projection normally.
      assert.equal(camera.usesTimeshiftLivestream, true, "usesTimeshiftLivestream reads true through the present record");
      assert.ok(camera.videoCodecName.length > 0, "videoCodecName reads a non-empty label through the present record");

      // The record vanishes (the camera unadopted, lingering in the removal grace). The getters must report their safe defaults, not throw on the vanished ufp read.
      store.removeCameraRecord(cameraConfig.id);

      await settle();

      assert.equal(camera.usesTimeshiftLivestream, false, "usesTimeshiftLivestream returns its false default over the vanished record");
      assert.equal(camera.videoCodecName, "", "videoCodecName returns its empty default over the vanished record");
    } finally {

      camera.cleanup();
    }
  });
});

// Build a REAL plain ProtectCamera over a recording event dispatch, as camera-reactions.test.ts does for its lastMotion tests: no smart detection, so
// shouldDeliverBareMotion is true and a truthy lastMotion advance routes to motionEventHandler, which the recording dispatch captures as a motion call. seedLastMotion,
// when supplied, is committed to the store record BEFORE the camera is constructed, so the lastMotion observer's baseline at subscribe already carries it.
async function buildMotionCamera(options: { seedLastMotion?: number } = {}): Promise<{ accessory: TestAccessory; camera: ProtectCamera; id: string;
  recording: TestRecordingDispatch; store: TestStateStore; }> {

  const cameraConfig = makeCameraConfig({ channels: G2_PRO_CHANNELS });
  const store = new TestStateStore(makeProtectState({ cameras: [cameraConfig] }));

  if(options.seedLastMotion !== undefined) {

    store.pushCameraPatch(cameraConfig.id, { lastMotion: options.seedLastMotion });
  }

  const { nvr } = makeTestNvr({ dispatch: (innerNvr: ProtectNvr): ProtectEventDispatch => new TestRecordingDispatch(innerNvr), store });
  const recording = nvr.events as unknown as TestRecordingDispatch;
  const accessory = makeTestAccessory("Test Camera", "uuid:record-present-gate-replay");
  const camera = new ProtectCamera(nvr as unknown as ProtectNvr, accessory as unknown as ProtectAccessory,
    new TestCameraProjection(cameraConfig.id, store) as unknown as Camera);

  await settle();

  return { accessory, camera, id: cameraConfig.id, recording, store };
}

// Capture the camera's current store record, hard-asserted present, so a test can restore exactly the record that leaves.
function captureRecord(store: TestStateStore, id: string): ProtectCameraConfig {

  const record = store.snapshot().cameras.get(id);

  assert.ok(record, "the camera record is present in the store before it is removed");

  return record;
}

// The record leaves (the gate drops that wake) and returns within the grace, each dispatch settled in turn so the return is a wake of its own. The record comes back
// as it left unless a patch says otherwise - the advanced-while-away test returns it carrying a later stamp.
async function leaveAndReturn(store: TestStateStore, id: string, patch: Partial<ProtectCameraConfig> = {}): Promise<void> {

  const record = captureRecord(store, id);

  store.removeCameraRecord(id);

  await settle();

  store.restoreCameraRecord({ ...record, ...patch });

  await settle();
}

describe("the occurrence replay guard when a record returns within the removal grace", () => {

  test("a delivered lastMotion stamp is not replayed when the record returns with it, and a later stamp still fires", async () => {

    const { camera, id, recording, store } = await buildMotionCamera();

    try {

      // Positive liveness control: the first truthy advance is a genuine change that fires exactly once, proving the observer and the recording dispatch are live.
      store.pushCameraPatch(id, { lastMotion: 1700000000000 });

      await settle();

      assert.deepEqual(recording.calls, [{ id, kind: "motion" }], "the first truthy lastMotion advance fired motionEventHandler exactly once");

      // The record leaves and returns unchanged within the grace. The store yields the same stamp again; the guard must swallow it.
      await leaveAndReturn(store, id);

      assert.deepEqual(recording.calls, [{ id, kind: "motion" }], "the record returning with the stamp it left with did not replay the motion");

      // The guard skipped the replay without killing the loop: a later stamp is a real change and fires.
      store.pushCameraPatch(id, { lastMotion: 1700000005000 });

      await settle();

      assert.deepEqual(recording.calls, [ { id, kind: "motion" }, { id, kind: "motion" } ],
        "a later lastMotion advance after the return still fired - the observer is live");
    } finally {

      camera.cleanup();
    }
  });

  test("a never-delivered baseline lastMotion stamp is not replayed when the record returns with it", async () => {

    // The hydrated-baseline case: the stamp is on the record before the observer subscribes, so it is the store's baseline and must never fire - not at subscribe, and
    // not when the record returns carrying it.
    const { camera, id, recording, store } = await buildMotionCamera({ seedLastMotion: 1700000000000 });

    try {

      assert.deepEqual(recording.calls, [], "the hydrated baseline stamp did not fire at subscribe (the vacuity guard)");

      await leaveAndReturn(store, id);

      assert.deepEqual(recording.calls, [], "the record returning with the never-delivered baseline stamp did not replay it");

      // Positive liveness control: a later stamp fires, so the suppression above is the guard's and not a dead observer's.
      store.pushCameraPatch(id, { lastMotion: 1700000005000 });

      await settle();

      assert.deepEqual(recording.calls, [{ id, kind: "motion" }], "a later lastMotion advance after the return fired - the observer is live");
    } finally {

      camera.cleanup();
    }
  });

  test("a lastMotion stamp that advanced while the record was away is delivered on return", async () => {

    const { camera, id, recording, store } = await buildMotionCamera();

    try {

      store.pushCameraPatch(id, { lastMotion: 1700000000000 });

      await settle();

      assert.deepEqual(recording.calls, [{ id, kind: "motion" }], "the first truthy lastMotion advance fired motionEventHandler exactly once");

      // The record returns carrying a LATER stamp than it left with: a detection that happened while it was away. The guard is an equality check against the last
      // delivered stamp, not a blanket post-grace suppression, so this return fires.
      await leaveAndReturn(store, id, { lastMotion: 1700000005000 });

      assert.deepEqual(recording.calls, [ { id, kind: "motion" }, { id, kind: "motion" } ], "the record returning with an advanced stamp delivered the new motion");
    } finally {

      camera.cleanup();
    }
  });

  test("a remove and a restore drained together do not replay the stamp either", async () => {

    const { camera, id, recording, store } = await buildMotionCamera();

    try {

      store.pushCameraPatch(id, { lastMotion: 1700000000000 });

      await settle();

      assert.deepEqual(recording.calls, [{ id, kind: "motion" }], "the first truthy lastMotion advance fired motionEventHandler exactly once");

      // The remove and the restore dispatch in one synchronous segment, as two frames from one socket chunk do: no settle between them, so both wakes drain with the
      // record already back. The gate passes the leaving wake (it sees the record present), and the guard must treat its undefined stamp as no occurrence - without
      // disturbing the memory the returning stamp is then matched against.
      const record = captureRecord(store, id);

      store.removeCameraRecord(id);
      store.restoreCameraRecord(record);

      await settle();

      assert.deepEqual(recording.calls, [{ id, kind: "motion" }], "the remove and restore drained together did not replay the motion");

      // The guard skipped both wakes without killing the loop: a later stamp is a real change and fires.
      store.pushCameraPatch(id, { lastMotion: 1700000005000 });

      await settle();

      assert.deepEqual(recording.calls, [ { id, kind: "motion" }, { id, kind: "motion" } ],
        "a later lastMotion advance after the same-segment return still fired - the observer is live");
    } finally {

      camera.cleanup();
    }
  });

  test("a falsy delivery advances the memory, so the stamp it displaced fires again when it comes back", async () => {

    const { camera, id, recording, store } = await buildMotionCamera();

    try {

      store.pushCameraPatch(id, { lastMotion: 1700000000000 });

      await settle();

      assert.deepEqual(recording.calls, [{ id, kind: "motion" }], "the first truthy lastMotion advance fired motionEventHandler exactly once");

      // A clear to 0 is a changed stamp the guard hands over (the handler's own truthy guard is what declines it), and handing it over moves the memory to 0. So the
      // original stamp coming back afterwards differs from the memory and is a fresh delivery, not a replay - the memory remembers the last stamp handed over, truthy
      // or not, and a later tidy-up that remembered only truthy stamps would make this re-advance read as a replay and fail here.
      store.pushCameraPatch(id, { lastMotion: 0 });

      await settle();

      assert.deepEqual(recording.calls, [{ id, kind: "motion" }], "the clear to 0 was handed over but the handler's truthy guard declined it");

      store.pushCameraPatch(id, { lastMotion: 1700000000000 });

      await settle();

      assert.deepEqual(recording.calls, [ { id, kind: "motion" }, { id, kind: "motion" } ], "the stamp returning after a clear fired again - the memory had moved to 0");
    } finally {

      camera.cleanup();
    }
  });

  test("a level slice still re-reads live state when the record returns unchanged (why the guard is opt-in)", async () => {

    const { accessory, camera, id, store } = await buildMotionCamera();

    try {

      const motionService = accessory.getService(Service.MotionSensor);

      assert.ok(motionService, "the plain camera configured its motion sensor at construction");
      assert.equal(motionService.getCharacteristic(Characteristic.StatusActive).value, true, "StatusActive initialized true from isReachable over the present record");

      // During the grace isReachable reads a vanished record (peek() undefined), so a reachability refresh - the NVR health loop's push - drives StatusActive false
      // underneath the unchanged camera.state slice.
      const record = captureRecord(store, id);

      store.removeCameraRecord(id);

      await settle();

      camera.refreshReachability();

      assert.equal(motionService.getCharacteristic(Characteristic.StatusActive).value, false, "the reachability refresh during the grace drove StatusActive false");

      // The SAME record returns, so camera.state is unchanged - and the level slice's return wake must still run updateAvailability, restoring StatusActive. This is
      // the wake the occurrence guard would have swallowed, and the reason it is opt-in rather than applied to every slice.
      store.restoreCameraRecord(record);

      await settle();

      assert.equal(motionService.getCharacteristic(Characteristic.StatusActive).value, true,
        "the camera.state observer re-read availability on the unchanged return - a level slice is not guarded");
    } finally {

      camera.cleanup();
    }
  });
});

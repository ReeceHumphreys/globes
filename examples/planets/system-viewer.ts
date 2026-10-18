import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGPUCoordinateSystem,
  WebGPURenderer,
} from "three/webgpu";
import {
  bodySceneOffset,
  sceneBodyOffset,
  orbitOffset,
  sceneOrbit,
  sceneSolarPosition,
  shownRadius,
  type SolarBody,
} from "tiled-globe";
import { BODIES, type BodyId } from "./bodies.ts";
import {
  CLOSE_RADII,
  HANDOFF_RADII,
  PRELOAD_RADII,
  CANCEL_RADII,
  zoomToward,
  type Arrival,
  type Departure,
} from "./zoom.ts";

const AU = 149_597_870_700;
const SUN_RADIUS_M = 695_700_000;
const SAMPLES = 128;

const RADIUS: Record<SolarBody, number> = {
  sun: SUN_RADIUS_M,
  earth: BODIES.earth.radiusMeters,
  moon: BODIES.moon.radiusMeters,
  mars: BODIES.mars.radiusMeters,
};
const COLOR: Record<SolarBody, number> = {
  sun: 0xfff1c7,
  earth: 0x3d7ec9,
  moon: 0xc8c6c0,
  mars: 0xc45c3e,
};
const BODIES_DRAW: SolarBody[] = ["sun", "earth", "moon", "mars"];

/**
 * Orrery in a camera-relative scene. Scrolling toward a body warms its globe and
 * swaps at about eight radii. Scrolling back out of the globe resumes here.
 * This view never builds a tiled surface.
 */
export async function startSystemViewer(handlers: {
  warm: (id: BodyId | null) => void;
  visit: (id: BodyId, arrival: Arrival) => boolean;
  /** Body-fixed camera pose to resume from, instead of the overview. */
  resume?: Departure & { id: BodyId };
  /** Called after the first frame. The orrery stays hidden until `show`. */
  reveal?: (show: () => void) => void;
}): Promise<() => void> {
  if (!("gpu" in navigator)) throw new Error("This globe requires WebGPU on HTTPS or localhost.");
  const container = document.createElement("div");
  container.className = "globe-container";
  if (handlers.reveal) container.style.visibility = "hidden";
  document.body.append(container);
  const labels = document.createElement("div");
  labels.style.cssText = "position:fixed;inset:0;z-index:1;pointer-events:none;overflow:hidden;";
  if (handlers.reveal) labels.style.visibility = "hidden";
  document.body.append(labels);
  const renderer = new WebGPURenderer({ antialias: true });
  renderer.toneMapping = NoToneMapping;
  const scene = new Scene();
  scene.background = new Color(0x07090f);
  // 75° matches the globe camera, so the body keeps its size across the handoff.
  const camera = new PerspectiveCamera(75, 1, 1e5, 1e13);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  const geometry = new SphereGeometry(1, 32, 24);
  const meshes = new Map<SolarBody, Mesh>();
  const labelNodes = new Map<SolarBody, HTMLDivElement>();
  for (const id of BODIES_DRAW) {
    const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: COLOR[id] }));
    mesh.name = id;
    mesh.userData.body = id;
    scene.add(mesh);
    meshes.set(id, mesh);
    const label = document.createElement("div");
    label.textContent = id === "sun" ? "Sun" : BODIES[id].name;
    label.style.cssText =
      "position:absolute;transform:translate(-50%,-100%);color:#f4f7fb;font:12px/1.2 system-ui,sans-serif;text-shadow:0 1px 2px #000;white-space:nowrap;";
    labels.append(label);
    labelNodes.set(id, label);
  }
  const orbits = new Map<"earth" | "mars" | "moon", Line>();
  for (const id of ["earth", "mars", "moon"] as const) {
    const positions = new Float32Array((SAMPLES + 1) * 3);
    const buffer = new BufferGeometry();
    const attribute = new BufferAttribute(positions, 3);
    attribute.setUsage(DynamicDrawUsage);
    buffer.setAttribute("position", attribute);
    const line = new Line(
      buffer,
      new LineBasicMaterial({
        color: COLOR[id],
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    line.frustumCulled = false;
    scene.add(line);
    orbits.set(id, line);
  }
  const panel = document.createElement("aside");
  panel.className = "panel";
  panel.innerHTML = `
    <strong>Solar system</strong>
    <p>Drag to look around. Scroll toward a planet and its globe takes over as you arrive.</p>
    <p>
      <button type="button" class="system-button" data-visit="earth">Earth</button>
      <button type="button" class="system-button" data-visit="moon">Moon</button>
      <button type="button" class="system-button" data-visit="mars">Mars</button>
    </p>
    <label>Time
      <select data-rate aria-label="Time rate">
        <option value="0" selected>Now, paused</option>
        <option value="86400">1 day / second</option>
        <option value="604800">1 week / second</option>
        <option value="2629746">1 month / second</option>
      </select>
    </label>
    <p data-clock></p>
    <small>Orbits use the same ephemeris as the globe's sunlight. The Moon is a short series, about a degree. Distant bodies stay large enough to see, then take their real size as you arrive.</small>
  `;
  if (handlers.reveal) panel.style.visibility = "hidden";
  document.body.append(panel);
  const clock = panel.querySelector<HTMLElement>("[data-clock]")!;
  let rate = 0;
  const onRate = (event: Event) => {
    rate = Number((event.target as HTMLSelectElement).value);
  };
  panel.querySelector<HTMLSelectElement>("[data-rate]")!.addEventListener("change", onRate);

  const focus = new Float64Array(3);
  const cam = new Float64Array(3);
  const offset = new Float64Array(3);
  let yaw = 0.6;
  let pitch = 0.45;
  let distance = 4 * AU;
  let epoch = handlers.resume?.timeMs ?? Date.now();
  let lastNow = performance.now();
  let resume = handlers.resume ?? null;
  let presented = false;
  let flight: {
    id: BodyId;
    fromCam: Float64Array;
    fromFocus: Float64Array;
    approach: Float64Array;
    start: number;
    seconds: number;
  } | null = null;
  let disposed = false;
  let frameId = 0;
  orbitOffset(yaw, pitch, distance, offset);
  cam[0] = offset[0];
  cam[1] = offset[1];
  cam[2] = offset[2];

  function adoptOrbit() {
    if (!flight) return;
    flight = null;
    const dx = cam[0] - focus[0];
    const dy = cam[1] - focus[1];
    const dz = cam[2] - focus[2];
    distance = Math.hypot(dx, dy, dz) || distance;
    pitch = Math.asin(Math.min(1, Math.max(-1, dy / distance)));
    yaw = Math.atan2(dx, dz);
  }

  function beginFlight(id: BodyId) {
    const body = new Float64Array(3);
    sceneSolarPosition(id, epoch, body);
    const dx = cam[0] - body[0];
    const dy = cam[1] - body[1];
    const dz = cam[2] - body[2];
    const span = Math.hypot(dx, dy, dz) || 1;
    const arrive = RADIUS[id] * HANDOFF_RADII;
    flight = {
      id,
      fromCam: new Float64Array(cam),
      fromFocus: new Float64Array(focus),
      approach: new Float64Array([dx / span, dy / span, dz / span]),
      start: performance.now(),
      seconds: Math.min(3.2, Math.max(0.8, Math.abs(span - arrive) / AU)),
    };
    handlers.warm(id);
  }

  /** Visible body nearest the look direction, within a cone around its drawn disc. */
  function aimedBody(): { id: BodyId; at: Float64Array } | null {
    const lookX = focus[0] - cam[0];
    const lookY = focus[1] - cam[1];
    const lookZ = focus[2] - cam[2];
    const look = Math.hypot(lookX, lookY, lookZ);
    if (look < 1) return null;
    let best: { id: BodyId; angle: number; at: Float64Array } | null = null;
    for (const id of ["earth", "moon", "mars"] as const) {
      const mesh = meshes.get(id)!;
      if (!mesh.visible) continue;
      const range = Math.hypot(mesh.position.x, mesh.position.y, mesh.position.z);
      if (range < 1) continue;
      const along =
        (mesh.position.x * lookX + mesh.position.y * lookY + mesh.position.z * lookZ) /
        (range * look);
      const angle = Math.acos(Math.min(1, Math.max(-1, along)));
      const limit = Math.max(0.35, 2 * Math.atan2(mesh.scale.x, range));
      if (angle > limit || (best && angle >= best.angle)) continue;
      best = {
        id,
        angle,
        at: new Float64Array([
          cam[0] + mesh.position.x,
          cam[1] + mesh.position.y,
          cam[2] + mesh.position.z,
        ]),
      };
    }
    return best;
  }

  const onVisitClick = (event: Event) => {
    const id = (event.target as HTMLElement).dataset.visit;
    if (id === "earth" || id === "moon" || id === "mars") beginFlight(id);
  };
  panel.addEventListener("click", onVisitClick);

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const canvas = renderer.domElement;
  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";
  let pointerId = -1;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;
  let dragging = false;
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    pointerId = event.pointerId;
    downX = lastX = event.clientX;
    downY = lastY = event.clientY;
    dragging = false;
    canvas.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (!dragging && Math.hypot(event.clientX - downX, event.clientY - downY) < 4) return;
    if (!dragging) adoptOrbit();
    dragging = true;
    canvas.style.cursor = "grabbing";
    // Drag moves the camera against the pointer, so the bodies follow the pointer.
    yaw -= dx * 0.005;
    pitch = Math.min(1.2, Math.max(-1.2, pitch + dy * 0.005));
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointerId = -1;
    canvas.style.cursor = "grab";
    if (!dragging) {
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const targets = ["earth", "moon", "mars"]
        .map((id) => meshes.get(id as SolarBody)!)
        .filter((mesh) => mesh.visible);
      const hit = raycaster.intersectObjects(targets)[0];
      const id = hit?.object.userData.body;
      if (id === "earth" || id === "moon" || id === "mars") beginFlight(id);
    }
    dragging = false;
  };
  const placed = new Float64Array(3);
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    adoptOrbit();
    // Use the camera the next frame would show, so several wheel events in one frame stack.
    orbitOffset(yaw, pitch, distance, offset);
    placed[0] = focus[0] + offset[0];
    placed[1] = focus[1] + offset[1];
    placed[2] = focus[2] + offset[2];
    const aimed = event.deltaY < 0 ? aimedBody() : null;
    const next = zoomToward(
      placed,
      focus,
      aimed?.at ?? null,
      event.deltaY,
      aimed ? RADIUS[aimed.id] * CLOSE_RADII : SUN_RADIUS_M * 3,
      40 * AU,
    );
    focus[0] = next.focus[0];
    focus[1] = next.focus[1];
    focus[2] = next.focus[2];
    yaw = next.yaw;
    pitch = next.pitch;
    distance = next.distance;
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  const bodyPos = new Float64Array(3);
  const earthPos = new Float64Array(3);
  const projected = new Vector3();
  let observer: ResizeObserver | undefined;
  function resize() {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    camera.aspect = width / height;
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(width, height);
  }
  function placeLine(
    id: "earth" | "mars" | "moon",
    originX: number,
    originY: number,
    originZ: number,
  ) {
    const samples = sceneOrbit(id, epoch, SAMPLES);
    const line = orbits.get(id)!;
    const array = (line.geometry.attributes.position as BufferAttribute).array as Float32Array;
    for (let i = 0; i < samples.length; i += 3) {
      array[i] = samples[i] + originX - cam[0];
      array[i + 1] = samples[i + 1] + originY - cam[1];
      array[i + 2] = samples[i + 2] + originZ - cam[2];
    }
    (line.geometry.attributes.position as BufferAttribute).needsUpdate = true;
  }
  function frame(now: number) {
    if (disposed) return;
    const dt = Math.min(0.25, (now - lastNow) / 1000);
    lastNow = now;
    if (!flight && !resume && rate) epoch += dt * rate * 1000;
    if (resume) {
      sceneSolarPosition(resume.id, epoch, bodyPos);
      sceneBodyOffset(resume.id, epoch, [resume.x, resume.y, resume.z], offset);
      focus[0] = bodyPos[0];
      focus[1] = bodyPos[1];
      focus[2] = bodyPos[2];
      cam[0] = bodyPos[0] + offset[0];
      cam[1] = bodyPos[1] + offset[1];
      cam[2] = bodyPos[2] + offset[2];
      distance = Math.hypot(offset[0], offset[1], offset[2]) || distance;
      pitch = Math.asin(Math.min(1, Math.max(-1, offset[1] / distance)));
      yaw = Math.atan2(offset[0], offset[2]);
      resume = null;
    } else if (flight) {
      const t = Math.min(1, (now - flight.start) / (flight.seconds * 1000));
      const u = t * t * (3 - 2 * t);
      sceneSolarPosition(flight.id, epoch, bodyPos);
      const arrive = RADIUS[flight.id] * HANDOFF_RADII;
      for (let i = 0; i < 3; i++) {
        const end = bodyPos[i] + flight.approach[i] * arrive;
        cam[i] = flight.fromCam[i] + (end - flight.fromCam[i]) * u;
        focus[i] = flight.fromFocus[i] + (bodyPos[i] - flight.fromFocus[i]) * u;
      }
    } else {
      orbitOffset(yaw, pitch, distance, offset);
      cam[0] = focus[0] + offset[0];
      cam[1] = focus[1] + offset[1];
      cam[2] = focus[2] + offset[2];
    }
    const lookX = focus[0] - cam[0];
    const lookY = focus[1] - cam[1];
    const lookZ = focus[2] - cam[2];
    const lookFlat = lookX * lookX + lookZ * lookZ;
    const pole = lookFlat < 1e-8 * (lookFlat + lookY * lookY);
    camera.up.set(pole ? 1 : 0, pole ? 0 : 1, 0);
    camera.position.set(0, 0, 0);
    camera.lookAt(lookX, lookY, lookZ);
    const view = Math.hypot(lookX, lookY, lookZ) || 1;
    camera.near = Math.max(100, view * 1e-4);
    // shortcut: one perspective depth. The Sun can clip in the last moment of a flight.
    camera.far = view + 8 * AU;
    camera.updateProjectionMatrix();

    sceneSolarPosition("earth", epoch, earthPos);
    const earthMesh = meshes.get("earth")!;
    const earthDist = Math.hypot(earthPos[0] - cam[0], earthPos[1] - cam[1], earthPos[2] - cam[2]);
    const earthShown = shownRadius(RADIUS.earth, earthDist);
    for (const id of BODIES_DRAW) {
      const at = id === "earth" ? earthPos : bodyPos;
      if (id !== "earth") sceneSolarPosition(id, epoch, at);
      const mesh = meshes.get(id)!;
      mesh.position.set(at[0] - cam[0], at[1] - cam[1], at[2] - cam[2]);
      const dist = Math.hypot(mesh.position.x, mesh.position.y, mesh.position.z);
      mesh.scale.setScalar(shownRadius(RADIUS[id], dist));
      const label = labelNodes.get(id)!;
      projected.copy(mesh.position).project(camera);
      const width = container.clientWidth;
      const height = container.clientHeight;
      const inFront =
        mesh.position.x * lookX + mesh.position.y * lookY + mesh.position.z * lookZ > 0;
      label.hidden = !inFront || projected.z < -1 || projected.z > 1;
      label.style.left = `${(projected.x * 0.5 + 0.5) * width}px`;
      label.style.top = `${(-projected.y * 0.5 + 0.5) * height - 14}px`;
    }
    const moon = meshes.get("moon")!;
    const moonFromEarth = Math.hypot(
      moon.position.x - earthMesh.position.x,
      moon.position.y - earthMesh.position.y,
      moon.position.z - earthMesh.position.z,
    );
    const moonApart = moonFromEarth > earthShown + moon.scale.x;
    moon.visible = moonApart;
    labelNodes.get("moon")!.hidden = labelNodes.get("moon")!.hidden || !moonApart;
    placeLine("earth", 0, 0, 0);
    placeLine("mars", 0, 0, 0);
    placeLine("moon", earthPos[0], earthPos[1], earthPos[2]);
    orbits.get("moon")!.visible = moonFromEarth / Math.max(earthDist, 1) > 0.01;

    clock.textContent = new Date(epoch).toISOString().slice(0, 16).replace("T", " ") + " UTC";
    document.getElementById("startup-status")?.remove();
    let nearest: { id: BodyId; range: number; x: number; y: number; z: number } | null = null;
    for (const id of ["earth", "moon", "mars"] as const) {
      if (!meshes.get(id)!.visible) continue;
      sceneSolarPosition(id, epoch, bodyPos);
      const x = cam[0] - bodyPos[0];
      const y = cam[1] - bodyPos[1];
      const z = cam[2] - bodyPos[2];
      const range = Math.hypot(x, y, z);
      if (!nearest || range / RADIUS[id] < nearest.range / RADIUS[nearest.id])
        nearest = { id, range, x, y, z };
    }
    if (flight) handlers.warm(flight.id);
    else if (nearest && nearest.range < RADIUS[nearest.id] * PRELOAD_RADII)
      handlers.warm(nearest.id);
    else if (!nearest || nearest.range > RADIUS[nearest.id] * CANCEL_RADII) handlers.warm(null);
    renderer.render(scene, camera);
    if (!presented) {
      presented = true;
      handlers.reveal?.(() => {
        container.style.visibility = "";
        panel.style.visibility = "";
        labels.style.visibility = "";
      });
    }
    // The flight stops on this sphere. Normalizing the approach can land a hair outside it.
    if (nearest && nearest.range <= RADIUS[nearest.id] * HANDOFF_RADII + 1) {
      const fixed = new Float64Array(3);
      bodySceneOffset(nearest.id, epoch, [nearest.x, nearest.y, nearest.z], fixed);
      if (
        handlers.visit(nearest.id, {
          x: fixed[0],
          y: fixed[1],
          z: fixed[2],
          timeMs: epoch,
          distanceMeters: nearest.range,
        })
      )
        return;
    }
    frameId = requestAnimationFrame(frame);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frameId);
    observer?.disconnect();
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.removeEventListener("wheel", onWheel);
    panel.removeEventListener("click", onVisitClick);
    panel.querySelector("[data-rate]")?.removeEventListener("change", onRate);
    panel.remove();
    labels.remove();
    geometry.dispose();
    for (const mesh of meshes.values()) (mesh.material as MeshBasicMaterial).dispose();
    for (const line of orbits.values()) {
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    }
    renderer.dispose();
    container.remove();
  }
  try {
    container.appendChild(canvas);
    resize();
    observer = new ResizeObserver(resize);
    observer.observe(container);
    await renderer.init();
    if (!("isWebGPUBackend" in renderer.backend)) throw new Error("A WebGPU adapter is required.");
    frameId = requestAnimationFrame(frame);
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

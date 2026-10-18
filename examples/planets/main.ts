import { BODIES, type BodyId } from "./bodies.ts";
import type { Arrival, Departure, HeldStart } from "./zoom.ts";

let dispose: (() => void) | undefined;
let returning: (() => void) | undefined;
let stopped = false;
let ticket = 0;
let failed: BodyId | null = null;

type Warm = {
  id: BodyId;
  reveal?: (arrival: Arrival) => void;
  stop?: () => void;
  cancelled: boolean;
};
let warm: Warm | undefined;

function fail(error: unknown) {
  console.error("[Globes] Startup failed", error);
  const status = document.getElementById("startup-status");
  if (status)
    status.textContent = "The globe could not start. Check the browser console for details.";
}

function status(text: string) {
  let node = document.getElementById("startup-status");
  if (!node) {
    node = document.createElement("p");
    node.id = "startup-status";
    node.setAttribute("role", "status");
    document.body.append(node);
  }
  node.textContent = text;
}

function remember(id: BodyId | null) {
  const url = new URL(location.href);
  const previous = url.searchParams.get("body");
  if (previous !== id) {
    for (const key of ["imagery", "regions", "heights"]) url.searchParams.delete(key);
  }
  if (id) url.searchParams.set("body", id);
  else url.searchParams.delete("body");
  history.replaceState(null, "", url);
}

function cancelReturning() {
  returning?.();
  returning = undefined;
}

function cancelWarm() {
  const current = warm;
  if (!current) return;
  warm = undefined;
  current.cancelled = true;
  current.stop?.();
}

function warmBody(id: BodyId | null) {
  if (!id) {
    failed = null;
    cancelWarm();
    return;
  }
  if (stopped || failed === id || warm?.id === id) return;
  cancelWarm();
  const mine: Warm = { id, cancelled: false };
  warm = mine;
  const hold: HeldStart = {
    hold: true,
    ready(reveal) {
      mine.reveal = reveal;
    },
  };
  // shortcut: a second WebGPU renderer builds the globe offscreen. Keep the orrery if the device refuses it.
  const onLeave = (pose: Departure) => {
    void returnToSystem(id, pose);
  };
  const starting =
    id === "moon"
      ? import("../moon/viewer.ts").then((mod) => mod.startViewer(hold, onLeave))
      : import("./viewer.ts").then((mod) => mod.startPlanetViewer(id, hold, onLeave));
  starting
    .then((stop) => {
      if (mine.cancelled || warm !== mine) {
        stop();
        return;
      }
      mine.stop = stop;
    })
    .catch((error: unknown) => {
      if (warm === mine) warm = undefined;
      if (mine.cancelled) return;
      failed = mine.id;
      console.error("[Globes] Globe preload failed", error);
    });
}

function attachSystemButton(stopViewer: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "system-button";
  button.textContent = "Solar system";
  const onClick = () => {
    void showSystem();
  };
  button.addEventListener("click", onClick);
  document.querySelector(".panel")?.prepend(button);
  dispose = () => {
    button.removeEventListener("click", onClick);
    button.remove();
    stopViewer();
  };
}

function tryReveal(id: BodyId, arrival: Arrival): boolean {
  if (!warm || warm.id !== id || !warm.reveal || !warm.stop) return false;
  const reveal = warm.reveal;
  const stopViewer = warm.stop;
  try {
    reveal(arrival);
  } catch (error) {
    console.error("[Globes] Globe handoff failed", error);
    return false;
  }
  warm = undefined;
  ++ticket;
  dispose?.();
  remember(id);
  attachSystemButton(stopViewer);
  return true;
}

async function returnToSystem(id: BodyId, pose: Departure) {
  const mine = ++ticket;
  cancelWarm();
  cancelReturning();
  try {
    const { startSystemViewer } = await import("./system-viewer.ts");
    if (stopped || mine !== ticket) return;
    let systemStop: (() => void) | undefined;
    const stop = await startSystemViewer({
      warm: warmBody,
      visit: tryReveal,
      resume: { id, ...pose },
      reveal(show) {
        if (mine !== ticket) return;
        dispose?.();
        show();
        remember(null);
        dispose = systemStop;
        returning = undefined;
      },
    });
    systemStop = stop;
    if (stopped || mine !== ticket) {
      stop();
      return;
    }
    returning = stop;
  } catch (error) {
    if (mine === ticket) console.error("[Globes] Return to the solar system failed", error);
  }
}

async function showSystem() {
  const mine = ++ticket;
  cancelWarm();
  cancelReturning();
  dispose?.();
  dispose = undefined;
  try {
    remember(null);
    status("Opening the solar system…");
    const { startSystemViewer } = await import("./system-viewer.ts");
    if (stopped || mine !== ticket) return;
    const stop = await startSystemViewer({ warm: warmBody, visit: tryReveal });
    if (stopped || mine !== ticket) {
      stop();
      return;
    }
    dispose = stop;
  } catch (error) {
    if (mine === ticket) fail(error);
  }
}

async function showBody(id: BodyId) {
  const mine = ++ticket;
  cancelWarm();
  cancelReturning();
  dispose?.();
  dispose = undefined;
  try {
    remember(id);
    status(`Opening ${BODIES[id].name}…`);
    const onLeave = (pose: Departure) => {
      void returnToSystem(id, pose);
    };
    const stopViewer =
      id === "moon"
        ? await (await import("../moon/viewer.ts")).startViewer(undefined, onLeave)
        : await (await import("./viewer.ts")).startPlanetViewer(id, undefined, onLeave);
    if (stopped || mine !== ticket) {
      stopViewer();
      return;
    }
    attachSystemButton(stopViewer);
  } catch (error) {
    if (mine === ticket) fail(error);
  }
}

const requested = new URLSearchParams(location.search).get("body");
void (requested && Object.hasOwn(BODIES, requested) ? showBody(requested as BodyId) : showSystem());
import.meta.hot?.dispose(() => {
  stopped = true;
  cancelWarm();
  cancelReturning();
  dispose?.();
});

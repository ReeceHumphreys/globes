import { startViewer } from "./viewer.ts";

let dispose: (() => void) | undefined;
let stopped = false;

startViewer()
  .then((cleanup) => {
    // Initialization may finish after hot reload has stopped this viewer.
    if (stopped) cleanup();
    else dispose = cleanup;
  })
  .catch((error: unknown) => {
    console.error("[Globes] Startup failed", error);
    const status = document.getElementById("startup-status");
    if (status)
      status.textContent = "The globe could not start. Check the browser console for details.";
  });

import.meta.hot?.dispose(() => {
  stopped = true;
  dispose?.();
});

import { runTerrainCacheBenchmark } from "./runner.ts";
const run = document.querySelector<HTMLButtonElement>("#run")!;
const save = document.querySelector<HTMLButtonElement>("#save")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const results = document.querySelector<HTMLPreElement>("#results")!;
let json = "";
run.addEventListener("click", async () => {
  run.disabled = save.disabled = true;
  try {
    const report = await runTerrainCacheBenchmark((message) => {
      status.textContent = message;
    });
    json = JSON.stringify(report, null, 2);
    results.textContent = json;
    status.textContent = "Complete. Timings are per dispatch, averaged over 256 repetitions.";
    save.disabled = false;
  } catch (error) {
    status.textContent = String(error);
  } finally {
    run.disabled = false;
  }
});
save.addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "terrain-cache-results.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

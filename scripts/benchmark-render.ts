// Times real frames on the real GPU: serves benchmarks/render, drives headless Chrome over
// the DevTools protocol and prints one row per case. CHROME overrides the browser path.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9334;

type Case = Record<string, string | number>;
const earth = (altitude: number, extra: Case = {}): Case => ({ body: "earth", altitude, ...extra });
const CASES: Case[] = [
  earth(19_000_000),
  earth(2_000_000),
  earth(200_000),
  earth(400_000),
  earth(400_000, { clouds: 1 }),
  earth(400_000, { clouds: 1, tilt: 1.2 }),
  earth(400_000, { clouds: 1, tilt: 1.2, bloom: 1 }),
  earth(19_000_000, { clouds: 1 }),
  earth(20_000),
  earth(20_000, { tilt: 1.2 }),
  earth(20_000, { moving: 0 }),
  earth(20_000, { atmosphere: 0 }),
  earth(20_000, { tilt: 1.2, atmosphere: 0 }),
  earth(20_000, { pixelRatio: 1.5 }),
  earth(20_000, { tilt: 1.2, pixelRatio: 1.5 }),
  { body: "moon", altitude: 20_000 },
  { body: "moon", altitude: 20_000, tilt: 1.2 },
  { body: "mars", altitude: 20_000 },
];

const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const address = server.httpServer!.address() as { port: number };
const profile = await mkdtemp(join(tmpdir(), "globes-benchmark-"));
const browser = spawn(
  chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--enable-unsafe-webgpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function connect() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const tabs = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)
      .then(
        (response) => response.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>,
      )
      .catch(() => []);
    const tab = tabs.find(({ type }) => type === "page");
    if (tab) return tab.webSocketDebuggerUrl;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome did not start: ${chrome}`);
}

try {
  const socket = new WebSocket(await connect());
  await new Promise((resolve) => (socket.onopen = resolve));
  let nextId = 0;
  const call = (method: string, params: object) =>
    new Promise<{ result: { result: { value: unknown }; exceptionDetails?: unknown } }>(
      (resolve) => {
        const id = ++nextId;
        const listener = (event: MessageEvent) => {
          const message = JSON.parse(event.data);
          if (message.id !== id) return;
          socket.removeEventListener("message", listener);
          resolve(message);
        };
        socket.addEventListener("message", listener);
        socket.send(JSON.stringify({ id, method, params }));
      },
    );
  const evaluate = (expression: string) =>
    call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

  console.log("case".padEnd(46) + "median ms   p95 ms   cpu ms   tiles   Mpixels");
  for (const settings of CASES) {
    const search = new URLSearchParams(settings as Record<string, string>);
    await call("Page.navigate", {
      url: `http://localhost:${address.port}/benchmarks/render/index.html?${search}`,
    });
    let result;
    for (let attempt = 0; attempt < 240; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      result = await evaluate("window.benchmark");
      if (result.result.exceptionDetails)
        throw new Error(JSON.stringify(result.result.exceptionDetails));
      if (result.result.result.value) break;
    }
    const row = result!.result.result.value as Record<string, number> | undefined;
    if (!row) throw new Error(`No result for ${search}`);
    if (settings === CASES[0]) console.log(`GPU: ${row.gpu}`);
    const name = Object.entries(settings)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    console.log(
      name.padEnd(46) +
        `${row.median.toFixed(1).padStart(9)}${row.p95.toFixed(1).padStart(9)}` +
        `${row.cpu.toFixed(1).padStart(9)}${String(row.tiles).padStart(8)}` +
        (row.pixels / 1e6).toFixed(1).padStart(10),
    );
  }

  // The real viewer under real input: zoom in, then drag fast, timing animation frames.
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1728,
    height: 1117,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await call("Page.navigate", { url: `http://localhost:${address.port}/?body=earth` });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const stats = async () =>
    (await evaluate(`document.querySelector("[data-stats]")?.textContent ?? ""`)).result.result
      .value as string;
  for (let attempt = 0; attempt < 120 && !(await stats()); attempt++) await sleep(250);
  const mouse = (type: string, x: number, y: number, extra: object = {}) =>
    call("Input.dispatchMouseEvent", { type, x, y, ...extra });
  const [x, y] = [1000, 560];
  const altitude = async () => Number(/([\d.]+) km/.exec(await stats())?.[1]);
  for (let i = 0; i < 200 && (await altitude()) > 50; i++) {
    await mouse("mouseWheel", x, y, { deltaX: 0, deltaY: -300 });
    await sleep(30);
  }
  await evaluate(`(() => {
    window.frames_ = [];
    let last = performance.now();
    const tick = (now) => { window.frames_.push(now - last); last = now; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`);
  await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
  for (let i = 0; i < 300; i++) {
    const angle = i * 0.11;
    await mouse("mouseMoved", x + 500 * Math.sin(angle), y + 350 * Math.sin(angle * 1.7), {
      button: "left",
      buttons: 1,
    });
    await sleep(8);
  }
  await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
  const intervals = (await evaluate("window.frames_")).result.result.value as number[];
  intervals.sort((a, b) => a - b);
  const percentile = (p: number) => intervals[Math.floor((intervals.length - 1) * p)].toFixed(1);
  console.log(
    `\nViewer drag at ${await altitude()} km: frame interval median ${percentile(0.5)} ms, ` +
      `p99 ${percentile(0.99)} ms, max ${percentile(1)} ms over ${intervals.length} frames`,
  );
  socket.close();
} finally {
  browser.kill();
  await server.close();
  // Chrome is still writing its profile as it exits.
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

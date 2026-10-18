import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = process.cwd();
const sdk =
  process.env.WASI_SDK_PATH ??
  (existsSync(resolve(root, ".toolchains")) ? readdirSync(resolve(root, ".toolchains")) : [])
    .filter((name) => name.startsWith("wasi-sdk-") && !name.endsWith(".gz"))
    .map((name) => resolve(root, ".toolchains", name))[0];
if (!sdk || !existsSync(resolve(sdk, "bin/clang++")))
  throw new Error("Set WASI_SDK_PATH or run npm run wasm:setup first.");
const exports = ["alloc", "free", "build"];
const args = [
  "-O3",
  "-msimd128",
  "-std=c++20",
  "-fno-exceptions",
  "-fno-rtti",
  "-nostdlib++",
  "-nostartfiles",
  "-Wl,--strip-all",
  "-Wl,--no-entry",
  "-Wl,--export-memory",
  ...exports.map((name) => `-Wl,--export=bounds_${name}`),
  "-Wl,--initial-memory=2097152",
  "-Wl,--max-memory=536870912",
  "native/elevation-bounds.cpp",
  "-o",
  "native/elevation-bounds.wasm",
];
const result = spawnSync(resolve(sdk, "bin/clang++"), args, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const sourceSha256 = createHash("sha256")
  .update(readFileSync("native/elevation-bounds.cpp"))
  .digest("hex");
const wasm = readFileSync("native/elevation-bounds.wasm");
const module = await WebAssembly.compile(wasm);
if (WebAssembly.Module.imports(module).length)
  throw new Error("Elevation bounds must not require a WASI host.");
const compiler = spawnSync(resolve(sdk, "bin/clang++"), ["--version"], {
  encoding: "utf8",
}).stdout.split("\n")[0];
writeFileSync(
  "native/elevation-bounds-build.json",
  JSON.stringify(
    {
      abi: 1,
      compiler,
      sourceSha256,
      wasmSha256: createHash("sha256").update(wasm).digest("hex"),
      bytes: wasm.length,
      flags: args.slice(0, -3),
    },
    null,
    2,
  ) + "\n",
);
console.info(`Built native/elevation-bounds.wasm (${wasm.length} bytes, no host imports).`);

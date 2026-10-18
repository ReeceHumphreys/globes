// Official WASI SDK 34, pinned release hashes. No global compiler installation.
import { mkdir, access, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const targets = {
  "darwin-arm64": [
    "arm64-macos",
    "9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9",
  ],
  "darwin-x64": [
    "x86_64-macos",
    "87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb",
  ],
  "linux-arm64": [
    "arm64-linux",
    "f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971",
  ],
  "linux-x64": ["x86_64-linux", "b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4"],
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target)
  throw new Error("Install official WASI SDK 34 manually and set WASI_SDK_PATH for this platform.");
const [name, digest] = target,
  folder = resolve(".toolchains"),
  sdk = `wasi-sdk-34.0-${name}`;
await mkdir(folder, { recursive: true });
try {
  await access(resolve(folder, sdk, "bin/clang++"));
  console.info("WASI SDK already installed.");
  process.exit(0);
} catch {}
const archive = resolve(folder, `${sdk}.tar.gz`);
const download = spawnSync(
  "curl",
  [
    "--fail",
    "--location",
    "--retry",
    "3",
    "--continue-at",
    "-",
    "--output",
    archive,
    `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/${sdk}.tar.gz`,
  ],
  { stdio: "inherit" },
);
if (download.status !== 0) process.exit(download.status ?? 1);
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
if (hash.digest("hex") !== digest) {
  // curl --continue-at will not replace a full archive.
  await rm(archive, { force: true });
  throw new Error("WASI SDK download checksum mismatch.");
}
const extract = spawnSync("tar", ["-xzf", archive, "-C", folder], { stdio: "inherit" });
if (extract.status !== 0) process.exit(extract.status ?? 1);
console.info(`Installed ${sdk}. Run npm run wasm:build.`);

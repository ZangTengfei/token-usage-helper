import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, resolve } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tools = resolve(root, "../../output/tauri-toolchain");
const env = { ...process.env };
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
if (existsSync(join(tools, "cargo/bin", cargo))) {
  env.CARGO_HOME = tools + "/cargo";
  env.RUSTUP_HOME = tools + "/rustup";
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  env[pathKey] = join(tools, "cargo/bin") + delimiter + (env[pathKey] || "");
}
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(process.execPath, ["scripts/prepare.mjs"]);
if (process.argv.includes("--test"))
  run(cargo, ["test", "--locked"], root + "/src-tauri");
else {
  const bundle = process.platform === "win32" ? "nsis" : "app";
  // Contributor packages build without the production updater signing key.
  const config = JSON.stringify({ bundle: { createUpdaterArtifacts: false } });
  run(process.execPath, [
    root + "/node_modules/@tauri-apps/cli/tauri.js",
    "build", "--bundles", bundle, "--config", config, "--", "--locked",
  ]);
}

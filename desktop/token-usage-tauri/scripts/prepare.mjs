import {
  mkdir,
  copyFile,
  readFile,
  writeFile,
  chmod,
  readdir,
  rm,
  cp,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  repo = resolve(root, "../..");
const resources = join(root, "src-tauri/resources"),
  dist = join(root, "dist");
const windows = process.platform === "win32";
if (
  !(windows && process.arch === "x64") &&
  !(process.platform === "darwin" && process.arch === "arm64")
)
  throw new Error("Supported build hosts: macOS ARM64 / Windows x64");
const platformPackage = windows
  ? "@tokscale/cli-win32-x64-msvc"
  : "@tokscale/cli-darwin-arm64";
const require = createRequire(import.meta.url);
const native = dirname(require.resolve(platformPackage));
const nativeVersion = JSON.parse(
  await readFile(require.resolve(platformPackage + "/package.json"), "utf8"),
).version;
if (nativeVersion !== "4.23.1")
  throw new Error(
    "Collector dependency mismatch: run npm ci in this desktop package before building (expected 4.23.1).",
  );
await rm(resources + "/collector", { recursive: true, force: true });
await mkdir(resources + "/collector", { recursive: true });
await mkdir(dist + "/renderer", { recursive: true });
await mkdir(dist + "/vendor", { recursive: true });
for (const f of windows
  ? ["tokscale.exe"]
  : ["tokscale", "libFoundationModels.dylib"])
  await copyFile(join(native, f), resources + "/collector/" + f);
if (!windows) await chmod(resources + "/collector/tokscale", 0o755);
const license = await fetch(
  "https://raw.githubusercontent.com/junhoyeo/tokscale/v4.23.1/LICENSE",
);
if (!license.ok) throw new Error("Cannot read pinned collector license");
await writeFile(resources + "/collector/LICENSE", await license.text());
await cp(
  join(repo, "desktop/token-usage/renderer/icons"),
  join(dist, "renderer/icons"),
  { recursive: true },
);
for (const name of await readdir(join(repo, "desktop/token-usage/renderer"))) {
  if (name === "icons") continue;
  let data = await readFile(join(repo, "desktop/token-usage/renderer", name));
  if (name.endsWith(".html")) {
    let html = data
      .toString()
      .replace(
        /\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
        "",
      );
    html = html.replace(
      '<script type="module" src=',
      '<script src="bridge.js"></script>\n    <script type="module" src=',
    );
    data = Buffer.from(html);
  }
  await writeFile(join(dist, "renderer", name), data);
}
await copyFile(
  join(root, "scripts/bridge.js"),
  join(dist, "renderer/bridge.js"),
);
const sharp = createRequire(join(repo, "package.json"))("sharp");
const mark = await readFile(join(repo, "public/logo-mark.webp"));
await mkdir(resources + "/icon.iconset", { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2]) {
    const pixels = size * scale;
    await sharp({
      create: {
        width: pixels,
        height: pixels,
        channels: 4,
        background: "#1F1F1F",
      },
    })
      .composite([
        {
          input: await sharp(mark)
            .resize(Math.round(pixels * 0.75), Math.round(pixels * 0.75), {
              fit: "inside",
            })
            .toBuffer(),
        },
      ])
      .png()
      .toFile(
        `${resources}/icon.iconset/icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
      );
  }
if (!windows)
  execFileSync("iconutil", [
    "-c",
    "icns",
    resources + "/icon.iconset",
    "-o",
    resources + "/icon.icns",
  ]);
await copyFile(
  resources + "/icon.iconset/icon_128x128.png",
  resources + "/icon.png",
);
await copyFile(resources + "/icon.png", dist + "/vendor/icon.png");
for (const scale of [1, 2]) {
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${22 * scale}" height="${22 * scale}" viewBox="0 0 22 22"><rect width="22" height="22" rx="6" fill="#1F1F1F"/></svg>`,
  );
  await sharp(background)
    .composite([
      {
        input: await sharp(mark)
          .resize(18 * scale, 18 * scale, { fit: "inside" })
          .png()
          .toBuffer(),
        gravity: "centre",
      },
    ])
    .png()
    .toFile(resources + `/tray${scale === 2 ? "@2x" : ""}.png`);
}
console.log(
  "Prepared shared frontend and fixed native collector; no Electron/Node runtime bundled.",
);

// ICO can embed a PNG image; retain its full alpha channel.
const png = await sharp(resources + "/icon.png")
  .resize(256, 256)
  .png()
  .toBuffer();
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
await writeFile(resources + "/icon.ico", Buffer.concat([ico, png]));

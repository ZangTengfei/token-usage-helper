import { mkdir, copyFile, chmod, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { siteOrigin, DEFAULT_SITE } from "../core.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor");
await mkdir(vendor, { recursive: true });
await writeFile(
  join(vendor, "build-config.json"),
  JSON.stringify({
    site: siteOrigin(process.env.CLUB_USAGE_BUILD_SITE || DEFAULT_SITE),
  }),
);
const require = createRequire(import.meta.url);
const platformPackage = {
  "darwin-arm64": "@tokscale/cli-darwin-arm64",
  "win32-x64": "@tokscale/cli-win32-x64-msvc",
}[process.platform + "-" + process.arch];
if (!platformPackage)
  throw new Error(
    "Unsupported build platform: " + process.platform + "-" + process.arch,
  );
const native = dirname(require.resolve(platformPackage));
const nativeVersion = JSON.parse(
  await readFile(require.resolve(platformPackage + "/package.json"), "utf8"),
).version;
if (nativeVersion !== "4.23.1")
  throw new Error(
    "Collector dependency mismatch: run npm ci in this desktop package before building (expected 4.23.1).",
  );
const executable = process.platform === "win32" ? "tokscale.exe" : "tokscale";
await copyFile(join(native, executable), join(vendor, executable));
if (process.platform === "darwin") {
  await chmod(join(vendor, executable), 0o755);
  await copyFile(
    join(native, "libFoundationModels.dylib"),
    join(vendor, "libFoundationModels.dylib"),
  );
}
await copyFile(
  join(root, "../../public/tools/club-usage.mjs"),
  join(vendor, "collector.mjs"),
);
for (const name of ["local-usage-adapters.mjs"])
  await copyFile(join(root, "../../public/tools", name), join(vendor, name));
// Reuse the community's existing brand asset, with macOS icon sizes.
const sharp = require("sharp");
const mark = await readFile(join(root, "../../public/logo-mark.webp"));
await mkdir(join(vendor, "icon.iconset"), { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2])
    await sharp({
      create: {
        width: size * scale,
        height: size * scale,
        channels: 4,
        background: "#1F1F1F",
      },
    })
      .composite([
        {
          input: await sharp(mark)
            .resize(
              Math.round(size * scale * 0.75),
              Math.round(size * scale * 0.75),
              { fit: "inside" },
            )
            .toBuffer(),
        },
      ])
      .png()
      .toFile(
        join(
          vendor,
          "icon.iconset",
          `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
        ),
      );
if (process.platform === "darwin")
  execFileSync("iconutil", [
    "-c",
    "icns",
    join(vendor, "icon.iconset"),
    "-o",
    join(vendor, "icon.icns"),
  ]);
await copyFile(
  join(vendor, "icon.iconset/icon_256x256.png"),
  join(vendor, "icon.png"),
);
// Square menu-bar badge; keep the official mark at its natural aspect ratio.
for (const scale of [1, 2, 3]) {
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${22 * scale}" height="${22 * scale}" viewBox="0 0 22 22"><rect width="22" height="22" rx="6" fill="#1F1F1F"/></svg>`,
  );
  const logo = await sharp(mark)
    .resize(18 * scale, 18 * scale, { fit: "inside" })
    .png()
    .toBuffer();
  await sharp(background)
    .composite([{ input: logo, gravity: "centre" }])
    .png()
    .toFile(join(vendor, `tray${scale === 1 ? "" : `@${scale}x`}.png`));
}
const license = await fetch(
  "https://raw.githubusercontent.com/junhoyeo/tokscale/v4.23.1/LICENSE",
);
if (!license.ok) throw new Error("Could not retrieve Tokscale MIT license");
await writeFile(join(vendor, "tokscale-LICENSE"), await license.text());
console.log("Prepared bundled collector and brand assets.");

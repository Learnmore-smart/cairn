// Renders brand/cairn-icon.svg to a 1024px PNG master, then shells out to
// `tauri icon` to produce the full platform icon set in src-tauri/icons/.
// Sizes <=64px are re-rendered from brand/cairn-icon-small.svg (bolder
// geometry that survives downscaling) and icon.ico is repacked with the
// correct artwork per layer. Usage: pnpm icons
import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(root, "brand", "cairn-icon.svg");
const smallSvgPath = join(root, "brand", "cairn-icon-small.svg");
const masterPath = join(root, "brand", "cairn-icon-1024.png");
const iconsDir = join(root, "src-tauri", "icons");
const faviconPath = join(root, "public", "favicon.png");

const render = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" })
    .render()
    .asPng();

const masterSvg = readFileSync(svgPath);
const smallSvg = readFileSync(smallSvgPath);

writeFileSync(masterPath, render(masterSvg, 1024));
console.log(`rendered ${masterPath}`);

mkdirSync(iconsDir, { recursive: true });
execFileSync("pnpm", ["tauri", "icon", masterPath, "-o", iconsDir], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

// Small-size pass — tauri icon downscales the detailed master to mush below
// 128px, so each small output is re-rendered from the simplified variant.
const SMALL_SIZES = new Set([16, 24, 32, 44, 48, 50, 64]);
const renderAt = (size) => render(SMALL_SIZES.has(size) ? smallSvg : masterSvg, size);

const overwrites = {
  "16x16.png": 16,
  "24x24.png": 24,
  "32x32.png": 32,
  "64x64.png": 64,
  "Square30x30Logo.png": 30,
  "Square44x44Logo.png": 44,
  "StoreLogo.png": 50,
};
for (const [name, size] of Object.entries(overwrites)) {
  writeFileSync(join(iconsDir, name), renderAt(size));
  console.log(`re-rendered icons/${name} @ ${size}px`);
}

// Repack icon.ico — PNG-compressed layers, small artwork <=64, master >=128.
const ICO_LAYERS = [16, 24, 32, 48, 64, 128, 256];
const pngs = ICO_LAYERS.map(renderAt);
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(ICO_LAYERS.length, 4);
const dir = Buffer.alloc(ICO_LAYERS.length * 16);
let offset = 6 + dir.length;
ICO_LAYERS.forEach((size, i) => {
  const o = i * 16;
  dir[o] = size >= 256 ? 0 : size; // 0 encodes 256
  dir[o + 1] = size >= 256 ? 0 : size;
  dir[o + 3] = 0; // reserved
  dir.writeUInt16LE(1, o + 4); // planes
  dir.writeUInt16LE(32, o + 6); // bpp
  dir.writeUInt32LE(pngs[i].length, o + 8);
  dir.writeUInt32LE(offset, o + 12);
  offset += pngs[i].length;
});
writeFileSync(join(iconsDir, "icon.ico"), Buffer.concat([header, dir, ...pngs]));
console.log(`repacked icons/icon.ico (${ICO_LAYERS.length} layers)`);

// Favicon = the 32px small render — keeps index.html in sync with the mark.
copyFileSync(join(iconsDir, "32x32.png"), faviconPath);
console.log(`synced ${faviconPath}`);

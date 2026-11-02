/**
 * Builds the home-widget product renders from the app's bundled SKU artwork.
 *
 * The source photos are mid-grey product shots on transparency, which read as
 * flat cut-outs on the widget's dark card. The tile wants the Nothing treatment
 * instead: a near-black body with the hinges, rims and etched text kept as
 * silver highlights. That is a luminance curve applied per pixel, not a tint,
 * so the frame's shape survives and every finish collapses to the same black.
 *
 * Only shape matters after the curve, so one source per frame is enough:
 * Frame A (round), Frame B (square), plus the generic G2 fallback.
 *
 *   node scripts/build-widget-art.cjs
 *
 * Output: App_Resources/Android/src/main/res/drawable-nodpi/widget_glasses_*.png
 */
const fs = require("fs");
const path = require("path");
const UPNG = require("upng-js");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "app/images/glasses");
const OUT = path.join(ROOT, "App_Resources/Android/src/main/res/drawable-nodpi");

/** floor + range * (luma / 255) ^ gamma: black body, silver highlights. */
const FLOOR = 14;
const RANGE = 241;
const GAMMA = 2.8;

const SOURCES = [
  ["glasses_g2_a_grey.png", "widget_glasses_g2_a.png"],
  ["glasses_g2_b_grey.png", "widget_glasses_g2_b.png"],
  ["even_realities_g2.png", "widget_glasses_g2.png"],
];

function blackRender(file, outName) {
  const buffer = fs.readFileSync(path.join(SRC, file));
  const image = UPNG.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const rgba = new Uint8Array(UPNG.toRGBA8(image)[0]);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const luma = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    const value = Math.round(FLOOR + RANGE * Math.pow(luma / 255, GAMMA));
    rgba[i] = value;
    rgba[i + 1] = value;
    rgba[i + 2] = value;
  }
  const png = UPNG.encode([rgba.buffer], image.width, image.height, 0);
  fs.writeFileSync(path.join(OUT, outName), Buffer.from(png));
  console.log(`${outName}  ${image.width}x${image.height}`);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [source, out] of SOURCES) blackRender(source, out);

/**
 * Measure the OFF-MAP MARGIN of a rendered map PNG, which is where R1 lives: at the world square's
 * west edge the land used to stop dead against a flat navy fill, a dead-straight hue boundary that
 * is the same defect class as the water cap rejected three times.
 *
 * Reports, for a vertical scan at each of a set of x columns, the mean colour; and for each row of
 * the image, the horizontal position of the strongest hue/luminance step inside the margin. A clean
 * margin has NO column at which a large fraction of the rows share the same step position.
 *
 *   node tools/mapgen/measure-margin.mjs renders/r/base-full.png [worldFracPad]
 */
import { loadImage, createCanvas } from '@napi-rs/canvas';

const file = process.argv[2];
if (!file) throw new Error('usage: measure-margin.mjs <png>');
const img = await loadImage(file);
const W = img.width, H = img.height;
const cv = createCanvas(W, H); const g = cv.getContext('2d');
g.drawImage(img, 0, 0);
const px = g.getImageData(0, 0, W, H).data;
const at = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// hue-ish: blue-minus-green, the axis that separates navy water from veld green
const bg = (c) => c[2] - c[1];

// Vertical straightness: for every column, how many rows show a strong step between x-1 and x+1?
const rows = [];
for (let y = 4; y < H - 4; y++) rows.push(y);
const colScore = new Float64Array(W);
for (const y of rows) {
  for (let x = 3; x < W - 3; x++) {
    const a = at(x - 3, y), b = at(x + 3, y);
    const d = Math.abs(lum(a) - lum(b)) + Math.abs(bg(a) - bg(b));
    colScore[x] += d;
  }
}
const top = [...colScore.keys()].sort((i, j) => colScore[j] - colScore[i]).slice(0, 8);
console.log(`image ${W}x${H}`);
console.log('strongest vertical edges (column, mean step magnitude over all rows):');
for (const x of top) console.log(`  x=${x}  ${(colScore[x] / rows.length).toFixed(1)}`);

// Same for horizontal edges, so a straight top/bottom termination is caught too.
const rowScore = new Float64Array(H);
for (let x = 4; x < W - 4; x++) {
  for (let y = 3; y < H - 3; y++) {
    const a = at(x, y - 3), b = at(x, y + 3);
    rowScore[y] += Math.abs(lum(a) - lum(b)) + Math.abs(bg(a) - bg(b));
  }
}
const topR = [...rowScore.keys()].sort((i, j) => rowScore[j] - rowScore[i]).slice(0, 5);
console.log('strongest horizontal edges (row, mean step magnitude):');
for (const y of topR) console.log(`  y=${y}  ${(rowScore[y] / (W - 8)).toFixed(1)}`);

// Column colour profile across the left third, so the navy/green split is visible as numbers.
console.log('column colour profile (x: mean rgb over the middle 80% of rows):');
for (let x = 0; x < Math.min(W, Math.round(W * 0.30)); x += Math.round(W / 64)) {
  let r = 0, gg = 0, b = 0, n = 0;
  for (let y = Math.round(H * 0.1); y < Math.round(H * 0.9); y++) { const c = at(x, y); r += c[0]; gg += c[1]; b += c[2]; n++; }
  console.log(`  x=${String(x).padStart(4)}  rgb(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)})`);
}

// Extracts the Anchor IDL(s) that app.fbyt.io embeds in its Next.js bundle.
// Usage:
//   1. Find the chunk that contains `"name":"fbyt_vault"` (browser devtools → Sources, or curl the chunks).
//   2. node scripts/extract-idl.cjs <chunk.js> [outDir=./idl-out]
// Each IDL found is written as <outDir>/<address-or-noaddress>.json. Copy the mainnet one to src/idl/fbyt_vault.json.
const fs = require('fs');
const path = require('path');

const [, , bundle, outDir = './idl-out'] = process.argv;
if (!bundle) {
  console.error('usage: node scripts/extract-idl.cjs <chunk.js> [outDir]');
  process.exit(1);
}
const src = fs.readFileSync(bundle, 'utf8');
const BS = String.fromCharCode(92); // backslash
fs.mkdirSync(outDir, { recursive: true });

let idx = -1;
let found = 0;
// The IDL is inlined as JSON.parse('<single-quoted JS string>'): find each, unescape, parse.
while ((idx = src.indexOf("JSON.parse('{\"address\":", idx + 1)) !== -1) {
  const start = idx + 12;
  let i = start;
  let esc = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (ch === BS) { esc = true; continue; }
    if (ch === "'") break;
  }
  const json = Function("return '" + src.slice(start, i) + "'")();
  const idl = JSON.parse(json);
  if (!idl.instructions) continue;
  const file = path.join(outDir, (idl.address || 'noaddress') + '.json');
  fs.writeFileSync(file, JSON.stringify(idl, null, 2));
  console.log(`${file}: ${idl.metadata?.name} v${idl.metadata?.version}, ${idl.instructions.length} instructions`);
  found++;
}
if (!found) console.error('No embedded Anchor IDL found in this file.');

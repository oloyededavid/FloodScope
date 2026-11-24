// The version number lives in js/version.js; package.json must carry the same number.
import { readFileSync } from 'node:fs';
import { VERSION } from '../js/version.js';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (pkg.version !== VERSION) { console.error(`package.json ${pkg.version} differs from js/version.js ${VERSION}`); process.exit(1); }
console.log(`version ${VERSION}: package.json and js/version.js agree`);

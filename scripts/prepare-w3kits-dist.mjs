import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, 'apps/web/out');
const dist = path.join(root, 'dist');

if (!fs.existsSync(out)) throw new Error('Missing apps/web/out; run the W3Kits plugin build first.');
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(out, dist, { recursive: true });

const index = path.join(dist, 'index.html');
if (!fs.existsSync(index)) throw new Error('Missing dist/index.html after copy.');

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, 'apps/web/out');
const dist = path.join(root, 'dist');

function listFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function sanitizeFileName(name) {
  return name.replace(/\.\.+/g, '-');
}

function rewriteStaticReferences(replacements) {
  if (replacements.size === 0) return;
  const textExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.txt']);
  for (const file of listFiles(dist)) {
    if (!textExtensions.has(path.extname(file))) continue;
    let content = fs.readFileSync(file, 'utf8');
    const original = content;
    for (const [from, to] of replacements) content = content.split(from).join(to);
    if (content !== original) fs.writeFileSync(file, content);
  }
}

function sanitizeObjectPaths() {
  const replacements = new Map();
  for (const file of listFiles(dist)) {
    const fileName = path.basename(file);
    const sanitized = sanitizeFileName(fileName);
    if (sanitized === fileName) continue;
    const nextFile = path.join(path.dirname(file), sanitized);
    if (fs.existsSync(nextFile)) throw new Error('Static asset rename collision: ' + nextFile);
    fs.renameSync(file, nextFile);
    replacements.set(fileName, sanitized);
  }
  rewriteStaticReferences(replacements);
}

if (!fs.existsSync(out)) throw new Error('Missing apps/web/out; run the W3Kits plugin build first.');
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(out, dist, { recursive: true });
sanitizeObjectPaths();

const index = path.join(dist, 'index.html');
if (!fs.existsSync(index)) throw new Error('Missing dist/index.html after copy.');

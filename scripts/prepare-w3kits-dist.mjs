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

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return { data: '', body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { data: '', body: raw };
  return { data: raw.slice(4, end), body: raw.slice(end + 4).replace(/^\n/, '') };
}

function yamlString(block, key, fallback = '') {
  const match = new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(block);
  if (!match) return fallback;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function yamlBlockString(block, key, fallback = '') {
  const literal = new RegExp('^' + key + ':\\s*\\|\\s*\\n((?:\\s{2,}.*\\n?)*)', 'm').exec(block);
  if (!literal) return yamlString(block, key, fallback);
  return literal[1]
    .split('\n')
    .map((line) => line.replace(/^\s{2}/, ''))
    .join('\n')
    .trim();
}

function yamlBool(block, key, fallback = false) {
  const value = yamlString(block, key, '');
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function yamlNumber(block, key) {
  const value = Number(yamlString(block, key, ''));
  return Number.isFinite(value) ? value : null;
}

function yamlList(block, key) {
  const inline = new RegExp('^' + key + ':\\s*\\[(.*?)\\]\\s*$', 'm').exec(block);
  if (inline) {
    return inline[1].split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  const list = new RegExp('^' + key + ':\\s*\\n((?:\\s{2}-\\s*.*\\n?)*)', 'm').exec(block);
  if (!list) return [];
  return list[1]
    .split('\n')
    .map((line) => /^\s{2}-\s*(.*)$/.exec(line)?.[1]?.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function yamlSection(block, key) {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => line.trim() === key + ':');
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line && !line.startsWith(' ')) break;
    out.push(line.replace(/^\s{2}/, ''));
  }
  return out.join('\n');
}

function derivePrompt(frontmatter) {
  const od = yamlSection(frontmatter, 'od');
  const prompt = yamlString(od, 'example_prompt', '');
  if (prompt) return prompt;
  const description = yamlBlockString(frontmatter, 'description', '');
  return description || yamlString(frontmatter, 'name', '');
}

function normalizeSkill(rootDir, entryName, source = 'built-in') {
  const file = path.join(rootDir, entryName, 'SKILL.md');
  const raw = fs.readFileSync(file, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const od = yamlSection(data, 'od');
  const designSystem = yamlSection(od, 'design_system');
  const preview = yamlSection(od, 'preview');
  const id = yamlString(data, 'name', entryName);
  const mode = yamlString(od, 'mode', body.includes('<artifact') ? 'prototype' : 'prototype');
  return {
    id,
    name: id,
    description: yamlBlockString(data, 'description', ''),
    triggers: yamlList(data, 'triggers'),
    mode,
    surface: yamlString(od, 'surface', mode === 'image' || mode === 'video' || mode === 'audio' ? mode : 'web'),
    source,
    craftRequires: yamlList(yamlSection(od, 'craft'), 'requires'),
    platform: yamlString(od, 'platform', '') || null,
    scenario: yamlString(od, 'scenario', '') || null,
    category: yamlString(od, 'category', '') || null,
    previewType: yamlString(preview, 'type', 'html'),
    designSystemRequired: yamlBool(designSystem, 'requires', true),
    defaultFor: yamlList(od, 'default_for'),
    upstream: yamlString(od, 'upstream', '') || null,
    featured: yamlNumber(od, 'featured'),
    fidelity: yamlString(od, 'fidelity', '') || null,
    speakerNotes: yamlBool(od, 'speaker_notes', false),
    animations: yamlBool(od, 'animations', false),
    hasBody: body.trim().length > 0,
    examplePrompt: derivePrompt(data),
    aggregatesExamples: false,
    body,
  };
}

function listSkillCatalog(relativeRoot) {
  const rootDir = path.join(root, relativeRoot);
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!fs.existsSync(path.join(rootDir, entry.name, 'SKILL.md'))) continue;
    try {
      out.push(normalizeSkill(rootDir, entry.name));
    } catch {
      // Keep plugin catalog generation best-effort, matching daemon discovery.
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function cleanTitle(value) {
  return String(value || '').replace(/[`*_]/g, '').trim();
}

function summarizeMarkdown(raw) {
  const body = raw.replace(/^#\s+.*$/m, '').replace(/^>\s*Category:.*$/m, '').trim();
  const paragraph = body.split(/\n\s*\n/).find((part) => part.trim() && !part.trim().startsWith('#')) || '';
  return paragraph.replace(/^>\s?/gm, '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function listDesignSystemCatalog() {
  const rootDir = path.join(root, 'design-systems');
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const file = path.join(rootDir, entry.name, 'DESIGN.md');
    if (!fs.existsSync(file)) continue;
    try {
      const body = fs.readFileSync(file, 'utf8');
      out.push({
        id: entry.name,
        title: cleanTitle(/^#\s+(.+)$/m.exec(body)?.[1] || entry.name),
        category: /^>\s*Category:\s*(.+)$/m.exec(body)?.[1]?.trim() || 'Uncategorized',
        summary: summarizeMarkdown(body),
        swatches: Array.from(new Set(body.match(/#[0-9a-fA-F]{6}\b/g) || [])).slice(0, 8),
        surface: /^>\s*Surface:\s*(image|video|audio|web)\b/im.exec(body)?.[1]?.toLowerCase() || 'web',
        body,
      });
    } catch {
      // Keep plugin catalog generation best-effort.
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function writeW3KitsCatalog() {
  const catalogDir = path.join(dist, '__w3kits', 'catalog');
  fs.mkdirSync(catalogDir, { recursive: true });
  fs.writeFileSync(path.join(catalogDir, 'skills.json'), JSON.stringify({ skills: listSkillCatalog('skills') }));
  fs.writeFileSync(path.join(catalogDir, 'design-templates.json'), JSON.stringify({ designTemplates: listSkillCatalog('design-templates') }));
  fs.writeFileSync(path.join(catalogDir, 'design-systems.json'), JSON.stringify({ designSystems: listDesignSystemCatalog() }));
}

if (!fs.existsSync(out)) throw new Error('Missing apps/web/out; run the W3Kits plugin build first.');
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(out, dist, { recursive: true });
sanitizeObjectPaths();
writeW3KitsCatalog();

const index = path.join(dist, 'index.html');
if (!fs.existsSync(index)) throw new Error('Missing dist/index.html after copy.');

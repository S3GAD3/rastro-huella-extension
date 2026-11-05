// Comprobaciones previas a publicar: sintaxis, coherencia de versiones, IDs del HTML y ficheros referenciados.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const errors = [];
const fail = m => errors.push(m);

// 1. Sintaxis de todos los JS
const js = ['background.js', ...readdirSync(join(ext, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f)];
for (const f of js) {
  try { execFileSync(process.execPath, ['--check', join(ext, f)], { stdio: 'pipe' }); }
  catch (e) { fail(`Sintaxis: ${f}\n${e.stderr}`); }
}

// 2. Versiones coherentes
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) fail(`Versión distinta: manifest ${manifest.version} / package.json ${pkg.version}`);
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`[${manifest.version}]`)) fail(`CHANGELOG.md no tiene entrada para ${manifest.version}`);

// 3. Ficheros del manifiesto
for (const p of [manifest.background.service_worker, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)])
  if (!existsSync(join(ext, p))) fail(`Falta ${p}`);

// 4. Cada #id usado en ui.js existe en app.html
const html = readFileSync(join(ext, 'app.html'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const ui = readFileSync(join(ext, 'js/ui.js'), 'utf8');
for (const [, id] of ui.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)) if (!ids.has(id)) fail(`ui.js usa #${id}, que no existe en app.html`);

// 5. Nada de datos personales evidentes
for (const f of js.concat(['app.html'])) {
  const t = readFileSync(join(ext, f), 'utf8');
  for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@(?:gmail|hotmail|outlook|yahoo|icloud|protonmail|proton)\.[a-z.]+/gi)) fail(`Posible correo real en ${f}: ${m[0]}`);
}

if (errors.length) { console.error('✗ ' + errors.join('\n✗ ')); process.exit(1); }
console.log(`✓ ${js.length} ficheros JS, versión ${manifest.version}, ${ids.size} IDs de interfaz: todo correcto`);

// Genera dist/RASTRO-HUELLA-v{versión}.zip listo para «Cargar descomprimida» y su .sha256.
// Sin dependencias: usa el escritor ZIP de la propia extensión.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipStore } from '../extension/js/zip.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const { version } = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
const folder = `RASTRO-HUELLA-v${version}`;

const walk = dir => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const date = new Date();
const files = walk(ext).filter(p => !/(^|\/)\./.test(relative(ext, p))).sort()
  .map(p => ({ name: `${folder}/${relative(ext, p).split('\\').join('/')}`, bytes: new Uint8Array(readFileSync(p)), date }));
files.push({ name: `${folder}/LICENSE`, bytes: new Uint8Array(readFileSync(join(root, 'LICENSE'))), date });
files.push({
  name: `${folder}/LEEME.txt`, date,
  bytes: [`RASTRO · HUELLA ${version}`, '',
    'Instalación: chrome://extensions (o edge://extensions) → Modo desarrollador → Cargar descomprimida',
    `→ selecciona esta carpeta (${folder}, la que contiene manifest.json).`, '',
    'Documentación completa, cambios y uso responsable: README.md y CHANGELOG.md del repositorio.',
    'Licencia MIT (fichero LICENSE).'].join('\r\n') + '\r\n'
});

mkdirSync(join(root, 'dist'), { recursive: true });
const zip = zipStore(files);
const out = join(root, 'dist', `${folder}.zip`);
writeFileSync(out, zip);
const hash = createHash('sha256').update(zip).digest('hex');
writeFileSync(out + '.sha256', `${hash}  ${folder}.zip\n`);
console.log(`✓ ${relative(root, out)} · ${files.length} ficheros · ${zip.length} bytes\n  SHA-256 ${hash}`);

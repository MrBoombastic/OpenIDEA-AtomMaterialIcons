import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { literalExtensions, associationRules } from './convert_atom_material.mjs';

assert.deepEqual(literalExtensions(String.raw`.*\.(ts|tsx)$`), ['ts', 'tsx']);
assert.deepEqual(literalExtensions(String.raw`.*\.rs$`), ['rs']);
assert.deepEqual(literalExtensions(String.raw`.*\.([cm]?js|es\d)$`), []);
assert.deepEqual(literalExtensions(String.raw`.*\.(json-?ld|ldjson)$`), []);
assert.deepEqual(associationRules('<associations><!-- <regex icon="fake"/> --><regex icon="high" priority="2"/><associations><regex icon="a&amp;b" priority="1" pattern="x&quot;y"/></associations></associations>'), [
  { icon: 'a&b', priority: '1', pattern: 'x"y' }, { icon: 'high', priority: '2' },
]);
assert.throws(() => associationRules('<associations>'));
assert.deepEqual(associationRules('<regex icon="a\n\tb" pattern="&#10;"/>'), [{ icon: 'a  b', pattern: '\n' }]);

const root = new URL('../', import.meta.url);
const theme = JSON.parse(readFileSync(new URL('icons/theme.json', root)));
const definitions = theme.iconDefinitions;
for (const [id, definition] of Object.entries(definitions)) {
  assert.match(id, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  for (const path of typeof definition === 'string' ? [definition] : Object.values(definition)) {
    assert.ok(existsSync(new URL(path, root)), path);
  }
}
const patterns = theme.patterns.map(rule => ({ ...rule, regex: new RegExp(rule.pattern, rule.ignoreCase ? 'i' : '') }));
for (const rule of patterns) {
  assert.ok(definitions[rule.icon]);
  if (rule.openIcon) assert.ok(definitions[rule.openIcon]);
}
for (const field of ['fileExtensions', 'fileNames', 'folderNames']) {
  for (const [name, id] of Object.entries(theme[field])) {
    assert.ok(!/[\\/]/.test(name), name);
    assert.ok(definitions[id], id);
  }
}
// Offline check of OpenIDEA's documented pattern/name/longest-extension order.
function resolve(name, path = null) {
  const pattern = patterns.find(rule => rule.target !== 'folder' && rule.regex.test(rule.path ? (path ?? '') : name));
  if (pattern) return pattern.icon;
  const lower = name.toLowerCase();
  if (theme.fileNames[lower]) return theme.fileNames[lower];
  const parts = lower.split('.');
  while (parts.length > 1) {
    parts.shift();
    if (theme.fileExtensions[parts.join('.')]) return theme.fileExtensions[parts.join('.')];
  }
  return theme.file;
}
for (const [name, expected] of Object.entries({
  'main.js': 'nodejs', 'example.js': 'js', 'example.mjs': 'js', 'example.cjs': 'js', 'example.ts': 'typescript',
  'main.rs': 'rust', 'main.py': 'python', 'main.go': 'go', 'Main.java': 'java',
  'README.md': 'readme', 'package.json': 'npm', 'Dockerfile': 'docker',
  '.gitignore': 'gitignore', 'unknown.zzznotanextension': 'file',
})) assert.equal(resolve(name), expected, name);
assert.equal(theme.folderNames['.github'], 'folder__github');
assert.equal(theme.folderNames['node_modules'], 'folder__node');
assert.equal(definitions.readme.dark, 'icons/files/readme_dark.svg');
const src = patterns.find(rule => rule.target === 'folder' && rule.regex.test('src'));
assert.equal(src.icon, 'folder__src');
assert.equal(src.openIcon, 'folder_open__src');
console.log(`OK: ${Object.keys(definitions).length} assets, ${patterns.length} regexes, common file/folder mappings`);

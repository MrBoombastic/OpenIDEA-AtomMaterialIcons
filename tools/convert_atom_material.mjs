import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';

const root = fileURLToPath(new URL('../', import.meta.url));

// Source regexes that are wrong upstream. IntelliJ hides these bugs with file-type icons, which aren't ported.
export const PATTERN_FIXES = {
  // `(-kit)` is missing `?`, so plain `.svelte` files never match.
  [String.raw`.*\.svelte(-kit)(\.[cm]?[jt]s)?`]: String.raw`.*\.svelte(-kit)?(\.[cm]?[jt]s)?$`,
};

export function literalExtensions(pattern) {
  const match = /^\.\*\\\.(?:\(([A-Za-z0-9|]+)\)|([A-Za-z0-9]+))\$?$/.exec(pattern);
  return match ? (match[1] || match[2]).split('|') : [];
}

export function associationRules(xml) {
  const rules = [];
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new Error('XML document types are not supported'); });
  parser.on('error', error => { throw error; });
  parser.on('opentag', tag => {
    if (tag.attributes.icon) rules.push({ ...tag.attributes });
  });
  parser.write(xml).close();
  return rules.sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
}

function convert(jar) {
  const definitions = Object.create(null);
  const sourceIds = new Map();
  const darkPaths = new Map();
  const skipped = [];
  const unsupported = JSON.parse(readFileSync(resolve(root, 'tools/unsupported-patterns.json')));
  const directories = { files: 'files', folders: 'folders', foldersOpen: 'folders-open' };
  const archive = unzipSync(readFileSync(jar), {
    filter: entry => /^assets\/icons\/(files|folders|foldersOpen)\/[^/]+\.svg$/.test(entry.name)
      || /^iconGenerator\/(icon|folder)_associations\.xml$/.test(entry.name),
  });
  for (const entry of Object.keys(archive).sort()) {
    if (!entry.startsWith('assets/icons/')) continue;
    const [, , kind, filename] = entry.split('/');
    const stem = basename(filename, '.svg');
    const data = archive[entry];
    if (data.length > 64 * 1024) {
      skipped.push(entry);
      continue;
    }
    const prefix = { files: '', folders: 'folder__', foldersOpen: 'folder_open__' }[kind];
    const iconId = (prefix + stem.replace(/_dark$/, '')).toLowerCase();
    assert.match(iconId, /^[a-z0-9][a-z0-9._-]{0,63}$/);
    const destination = `icons/${directories[kind]}/${filename}`;
    mkdirSync(resolve(root, 'icons', directories[kind]), { recursive: true });
    // OpenIDEA rejects these profile/spacing/rendering attributes; geometry and colours stay intact.
    const svg = Buffer.from(data).toString('utf8')
      .replace(/\s+baseProfile="[^"]*"/g, '')
      .replaceAll(' word-spacing="0"', '')
      .replaceAll(' image-rendering="optimizeQuality"', '');
    writeFileSync(resolve(root, destination), svg);
    if (stem.endsWith('_dark')) darkPaths.set(iconId, destination);
    else {
      assert.ok(!Object.hasOwn(definitions, iconId), iconId);
      definitions[iconId] = destination;
      sourceIds.set(`${kind}/${stem}`, iconId);
    }
  }
  for (const [iconId, dark] of darkPaths) {
    assert.ok(Object.hasOwn(definitions, iconId), iconId);
    definitions[iconId] = { light: definitions[iconId], dark };
  }

  const extensions = Object.create(null);
  const names = Object.create(null);
  const folders = Object.create(null);
  const patterns = [];
  for (const [xmlName, kind, mapping, attr] of [
    ['icon_associations.xml', 'files', names, 'fileNames'],
    ['folder_associations.xml', 'folders', folders, 'folderNames'],
  ]) {
    const rules = associationRules(Buffer.from(archive[`iconGenerator/${xmlName}`]).toString('utf8'));
    const convertedPatterns = [];
    for (const rule of rules) {
      const stem = basename(rule.icon, '.svg');
      const iconId = sourceIds.get(`${kind}/${stem}`);
      if (!iconId) continue;
      for (const value of (rule[attr] || '').split(',')) {
        const name = value.trim().toLowerCase();
        if (name && !/[*?/\\]/.test(name)) mapping[name] = iconId;
      }
      const pattern = PATTERN_FIXES[rule.pattern] ?? (rule.pattern || '');
      const literal = kind === 'files' ? literalExtensions(pattern) : [];
      if (literal.length) {
        for (const extension of literal) extensions[extension.toLowerCase()] = iconId;
      } else if (pattern && !Object.hasOwn(unsupported, pattern)) {
        const converted = { pattern, icon: iconId, ignoreCase: true };
        if (pattern.includes('/')) converted.path = true;
        if (kind === 'folders') {
          converted.target = 'folder';
          const opened = sourceIds.get(`foldersOpen/${stem}`);
          if (opened) converted.openIcon = opened;
        }
        convertedPatterns.push(converted);
      }
    }
    // Higher-priority rules must run before generic extension patterns.
    patterns.push(...convertedPatterns.reverse());
  }
  const theme = {
    iconDefinitions: definitions, file: 'file', folder: 'folder__folder',
    folderExpanded: 'folder_open__folder', fileExtensions: extensions,
    fileNames: names, folderNames: folders, patterns, folderOpen: 'folder_open__folder',
    settings: [{ title: 'File and folder icons', items: [
      { option: 'hideFiles', invert: true, label: 'Show file icons' },
      { option: 'hideFolders', invert: true, label: 'Show folder icons' },
      { option: 'hollowFolders', label: 'Use open icons for folders containing an open file' },
    ] }],
  };
  assert.ok(Object.keys(definitions).length <= 5000);
  assert.ok([extensions, names, folders, patterns].reduce((sum, value) => sum + Object.keys(value).length, 0) <= 20000);
  for (const field of ['file', 'folder', 'folderExpanded', 'folderOpen']) assert.ok(definitions[theme[field]]);
  for (const mapping of [extensions, names, folders]) {
    for (const iconId of Object.values(mapping)) assert.ok(definitions[iconId], iconId);
  }
  for (const rule of patterns) {
    assert.ok(definitions[rule.icon]);
    if (rule.openIcon) assert.ok(definitions[rule.openIcon]);
  }
  writeFileSync(resolve(root, 'icons/theme.json'), JSON.stringify(theme, null, 2) + '\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(theme)
    .filter(([, value]) => typeof value === 'object')
    .map(([key, value]) => [key, Object.keys(value).length])), null, 2));
  console.log('Oversized SVGs skipped:', skipped.join(', '));
  console.log('Unsupported source patterns:', Object.keys(unsupported).length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'Usage: node tools/convert_atom_material.mjs <jar>');
  convert(process.argv[2]);
}

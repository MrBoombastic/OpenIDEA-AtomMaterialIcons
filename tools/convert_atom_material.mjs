import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';

const root = fileURLToPath(new URL('../', import.meta.url));

// Source regexes that are wrong upstream. IntelliJ hides these bugs with file-type icons, which aren't ported.
export const PATTERN_FIXES = {
  // `(-kit)` is missing `?`, so plain `.svelte` files never match.
  [String.raw`.*\.svelte(-kit)(\.[cm]?[jt]s)?`]: String.raw`.*\.svelte(-kit)?(\.[cm]?[jt]s)?$`,
};

// IntelliJ resource folders Atom Material replaces icons from, in lookup order (see its icon_patchers.xml).
const UI_SOURCES = ['icons/expui/', 'glyphs/expui/', 'files/expui/', 'icons/', 'glyphs/', 'files/'];

// OpenIDEA icons not replaced: `check` is drawn on the accent-coloured checkbox, where a fixed-colour mark disappears.
const UI_EXCLUDED = new Set(['check']);

// Attributes OpenIDEA keeps on the root <svg>; it inlines only the body, inside its own <svg fill="none">.
const ROOT_ONLY = /^(xmlns(:\w+)?|width|height|viewBox|version|id|x|y|xml:space|class|preserveAspectRatio|data-[\w-]+)$/;
// IntelliJ's grey for monochrome icons; OpenIDEA recolours icons drawn only in it to match the theme.
const DEFAULT_FILL = '#6C707E';

// OpenIDEA rejects these profile/spacing/rendering attributes; geometry and colours stay intact.
// Paint set on the root <svg> (or left to SVG's default black) would be lost, so it moves to a wrapping <g>.
export function cleanSvg(data) {
  const svg = Buffer.from(data).toString('utf8')
    .replace(/\s+baseProfile="[^"]*"/g, '')
    .replaceAll(' word-spacing="0"', '')
    .replaceAll(' image-rendering="optimizeQuality"', '');
  const open = /<svg\b[^>]*>/.exec(svg);
  const close = svg.lastIndexOf('</svg>');
  if (!open || close < open.index) return svg;
  const kept = [];
  const moved = [];
  for (const [, name, value] of open[0].matchAll(/\s([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    (ROOT_ONLY.test(name) ? kept : moved).push(`${name}="${value}"`);
  }
  if (!/\bfill\s*[=:]/.test(svg)) moved.push(`fill="${DEFAULT_FILL}"`);
  const body = svg.slice(open.index + open[0].length, close);
  const inner = moved.length ? `<g ${moved.join(' ')}>${body}</g>` : body;
  return `${svg.slice(0, open.index)}<svg ${kept.join(' ')}>${inner}</svg>${svg.slice(close + 6)}`;
}

// Accepts the plugin's distribution zip or its main jar (with common.jar next to it).
function loadArchives(input) {
  const svgOrXml = entry => /\.(svg|xml)$/.test(entry.name);
  const bytes = readFileSync(input);
  if (input.toLowerCase().endsWith('.zip')) {
    const jars = unzipSync(bytes, { filter: entry => /\/lib\/(a-file-icon-idea-[^/]+|common)\.jar$/.test(entry.name) });
    const find = re => Object.keys(jars).find(name => re.test(name));
    const main = find(/a-file-icon-idea-[^/]+\.jar$/);
    const common = find(/\/common\.jar$/);
    assert.ok(main && common, 'zip must contain lib/a-file-icon-idea-*.jar and lib/common.jar');
    return { main: unzipSync(jars[main], { filter: svgOrXml }), common: unzipSync(jars[common], { filter: svgOrXml }) };
  }
  const commonJar = resolve(dirname(input), 'common.jar');
  assert.ok(existsSync(commonJar), `${commonJar} not found; pass the plugin zip instead`);
  return { main: unzipSync(bytes, { filter: svgOrXml }), common: unzipSync(readFileSync(commonJar), { filter: svgOrXml }) };
}

// Replacements for OpenIDEA's built-in icons: `overrides` maps an OpenIDEA icon name to an Atom Material SVG
// at the same JetBrains path. OpenIDEA's own icons (`openidea/…`) have no Atom counterpart.
function uiOverrides(common, definitions, skipped) {
  const { icons } = JSON.parse(readFileSync(resolve(root, 'tools/openidea-ui-icons.json')));
  const overrides = Object.create(null);
  for (const [name, path] of Object.entries(icons)) {
    if (path.startsWith('openidea/') || UI_EXCLUDED.has(name)) continue;
    const source = UI_SOURCES.map(prefix => prefix + path).find(candidate => common[`${candidate}.svg`]);
    if (!source) continue;
    const iconId = `ui__${source.replaceAll('/', '.')}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    assert.match(iconId, /^[a-z0-9][a-z0-9._-]{0,63}$/);
    if (!Object.hasOwn(definitions, iconId)) {
      const variants = {};
      for (const [variant, suffix] of [['light', '.svg'], ['dark', '_dark.svg']]) {
        const data = common[source + suffix];
        if (!data) continue;
        if (data.length > 64 * 1024) {
          skipped.push(source + suffix);
          continue;
        }
        const destination = `icons/ui/${source}${suffix}`;
        mkdirSync(dirname(resolve(root, destination)), { recursive: true });
        writeFileSync(resolve(root, destination), cleanSvg(data));
        variants[variant] = destination;
      }
      if (!variants.light) continue;
      definitions[iconId] = variants.dark ? variants : variants.light;
    }
    overrides[name] = iconId;
  }
  return overrides;
}

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
  const { main: archive, common } = loadArchives(jar);
  for (const entry of Object.keys(archive).sort()) {
    if (!/^assets\/icons\/(files|folders|foldersOpen)\/[^/]+\.svg$/.test(entry)) continue;
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
    writeFileSync(resolve(root, destination), cleanSvg(data));
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
  const overrides = uiOverrides(common, definitions, skipped);
  const theme = {
    iconDefinitions: definitions, file: 'file', folder: 'folder__folder',
    folderExpanded: 'folder_open__folder', fileExtensions: extensions,
    fileNames: names, folderNames: folders, patterns, overrides, folderOpen: 'folder_open__folder',
    settings: [{ title: 'File and folder icons', items: [
      { option: 'hideFiles', invert: true, label: 'Show file icons' },
      { option: 'hideFolders', invert: true, label: 'Show folder icons' },
      { option: 'hideUiIcons', invert: true, label: 'Show UI icons', hint: 'Tool windows, actions and file types' },
      { option: 'hidePsiIcons', invert: true, label: 'Show symbol icons', hint: 'Classes, methods and other code elements' },
      { option: 'hollowFolders', label: 'Use open icons for folders containing an open file' },
    ] }],
  };
  assert.ok(Object.keys(definitions).length <= 5000);
  assert.ok([extensions, names, folders, patterns].reduce((sum, value) => sum + Object.keys(value).length, 0) <= 20000);
  for (const field of ['file', 'folder', 'folderExpanded', 'folderOpen']) assert.ok(definitions[theme[field]]);
  for (const mapping of [extensions, names, folders]) {
    for (const iconId of Object.values(mapping)) assert.ok(definitions[iconId], iconId);
  }
  for (const iconId of Object.values(overrides)) assert.ok(definitions[iconId], iconId);
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
  assert.equal(process.argv.length, 3, 'Usage: node tools/convert_atom_material.mjs <plugin zip or jar>');
  convert(process.argv[2]);
}

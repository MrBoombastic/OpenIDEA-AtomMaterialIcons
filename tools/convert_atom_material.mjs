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

// Source regexes OpenIDEA's pattern checker refuses are matched by the plugin's code instead (path icons, API 1.8).
// That code uses Rust's regex crate, which has no lookaround: these are equivalent rewrites.
export const PATH_RULE_FIXES = {
  // Any `renovate`, `renovaterc` or `renovate[rc].json` name ending, except the plain name `renovate`.
  [String.raw`(?!^renovate$)(\.|^)renovate(rc)?(\.json)?$`]: String.raw`(.*\.|\.?)renovate(rc|rc\.json|\.json)|.*\.renovate`,
};
// Extra file name globs for path rules whose extension can't be read off the pattern.
const PATH_RULE_GLOBS = {
  [String.raw`(.*\.|\.?)renovate(rc|rc\.json|\.json)|.*\.renovate`]: ['*renovaterc', '*.renovate'],
  [String.raw`^cordova([^.]*\.|-(\d\.)+)[cm]?[jt]s$`]: ['cordova*'],
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

// Expands a small regex (literals, `[ab]`, `(a|b)`, `?`, escapes) into every string it matches; null if it can't.
export function expandRegex(source) {
  let i = 0;
  const alternatives = () => {
    const out = [];
    for (;;) {
      let seq = [''];
      while (i < source.length && source[i] !== '|' && source[i] !== ')') {
        let atom;
        const c = source[i++];
        if (c === '(') {
          if (source.startsWith('?:', i)) i += 2;
          atom = alternatives();
          if (!atom || source[i++] !== ')') return null;
        } else if (c === '[') {
          const end = source.indexOf(']', i);
          if (end < 0) return null;
          atom = [...source.slice(i, end)];
          if (atom.some(ch => !/[A-Za-z0-9]/.test(ch))) return null;
          i = end + 1;
        } else if (c === '\\') {
          const next = source[i++];
          if (!/[.\-]/.test(next)) return null;
          atom = [next];
        } else if (/[A-Za-z0-9_-]/.test(c)) atom = [c];
        else return null;
        if (source[i] === '?') {
          i++;
          atom = ['', ...atom];
        }
        seq = seq.flatMap(prefix => atom.map(part => prefix + part));
        if (seq.length > 256) return null;
      }
      out.push(...seq);
      if (source[i] !== '|') return out;
      i++;
    }
  };
  const result = alternatives();
  return result && i === source.length ? [...new Set(result)] : null;
}

// File extensions a rule can end with: the part after its last `\.`, expanded.
export function patternExtensions(pattern) {
  const body = pattern.replace(/\$$/, '');
  // The last `\.` outside any group.
  let dot = -1;
  for (let i = 0, depth = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      if (body[i + 1] === '.' && depth === 0) dot = i;
      i++;
    } else if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
  }
  if (dot < 0) return null;
  const tail = body.slice(dot + 2);
  // An optional extension group (`\.(a|b)?`) can also end in a bare dot; ignore that case.
  const expanded = expandRegex(tail.endsWith(')?') ? tail.slice(0, -1) : tail);
  return expanded && expanded.every(Boolean) ? expanded.map(e => e.toLowerCase()) : null;
}

// File rules for the plugin's code (rules/path-icons.json): the source regexes OpenIDEA refuses, plus every other
// rule that could outrank them. Atom Material picks the highest-priority match (the first one on a tie), with
// regexes that contain `/` matched against the whole path and the rest against the name.
export function pathIconRules(rules, sourceIds, unsupported) {
  const all = [];
  for (const [order, rule] of rules.entries()) {
    const iconId = sourceIds.get(`files/${basename(rule.icon, '.svg')}`);
    if (!iconId || !rule.pattern) continue;
    const original = PATTERN_FIXES[rule.pattern] ?? rule.pattern;
    const dynamic = Object.hasOwn(unsupported, original);
    const pattern = dynamic ? (PATH_RULE_FIXES[original] ?? original) : original;
    all.push({ order, priority: Number(rule.priority || 0), original, pattern, icon: dynamic ? iconId : '' });
  }
  const dynamic = all.filter(rule => rule.icon);
  assert.equal(new Set(dynamic.map(rule => rule.original)).size, Object.keys(unsupported).length,
    'every unsupported pattern needs a source rule');
  const lowest = Math.min(...dynamic.map(rule => rule.priority));
  // Rules are listed best first, so the plugin can stop at the first match.
  const listed = all.filter(rule => rule.priority >= lowest)
    .sort((a, b) => b.priority - a.priority || a.order - b.order);
  const extensions = new Set();
  const names = new Set();
  for (const rule of dynamic) {
    const extra = PATH_RULE_GLOBS[rule.pattern];
    if (extra) extra.forEach(glob => names.add(glob));
    else {
      const found = patternExtensions(rule.pattern);
      assert.ok(found, `no file extensions in ${rule.pattern}`);
      found.forEach(extension => extensions.add(extension));
    }
  }
  const globs = [`**/*.{${[...extensions].sort().join(',')}}`, ...[...names].sort().map(name => `**/${name}`)];
  return {
    globs,
    rules: listed.map(rule => [rule.priority, rule.pattern, rule.icon]),
    icons: [...new Set(dynamic.map(rule => rule.icon))].sort(),
  };
}

// Rewrites the generated `[[contributes.fileIcons]]` block of plugin.toml: one entry per path-rule icon.
function writeFileIcons(icons, definitions) {
  const manifestPath = resolve(root, 'plugin.toml');
  const begin = '# BEGIN generated by tools/convert_atom_material.mjs: icons for path rules\n';
  const end = '# END generated\n';
  const entries = icons.map(id => {
    const definition = definitions[id];
    const { light, dark } = typeof definition === 'string' ? { light: definition } : definition;
    return `[[contributes.fileIcons]]\nid = "${id}"\nicon = "${light}"\n${dark ? `iconDark = "${dark}"\n` : ''}`;
  });
  const manifest = readFileSync(manifestPath, 'utf8').replace(/\r\n/g, '\n');
  const start = manifest.indexOf(begin);
  const stop = manifest.indexOf(end);
  assert.ok(start >= 0 && stop > start, 'plugin.toml must contain the generated fileIcons markers');
  writeFileSync(manifestPath, manifest.slice(0, start) + begin + entries.join('\n') + '\n' + end + manifest.slice(stop + end.length));
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
  let pathIcons;
  for (const [xmlName, kind, mapping, attr] of [
    ['icon_associations.xml', 'files', names, 'fileNames'],
    ['folder_associations.xml', 'folders', folders, 'folderNames'],
  ]) {
    const rules = associationRules(Buffer.from(archive[`iconGenerator/${xmlName}`]).toString('utf8'));
    if (kind === 'files') pathIcons = pathIconRules(rules, sourceIds, unsupported);
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
  for (const iconId of pathIcons.icons) assert.ok(definitions[iconId], iconId);
  mkdirSync(resolve(root, 'rules'), { recursive: true });
  // One rule per line: [priority, regex, icon id ('' for rules the icon theme already handles)].
  writeFileSync(resolve(root, 'rules/path-icons.json'), `{"globs": ${JSON.stringify(pathIcons.globs)},\n"rules": [\n${
    pathIcons.rules.map(rule => JSON.stringify(rule)).join(',\n')}\n]}\n`);
  writeFileIcons(pathIcons.icons, definitions);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(theme)
    .filter(([, value]) => typeof value === 'object')
    .map(([key, value]) => [key, Object.keys(value).length])), null, 2));
  console.log('Oversized SVGs skipped:', skipped.join(', '));
  console.log('Unsupported source patterns (matched by the plugin by path):', Object.keys(unsupported).length);
  console.log('Path rules:', pathIcons.rules.length, 'with', pathIcons.icons.length, 'icons; globs:', pathIcons.globs.join(' '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'Usage: node tools/convert_atom_material.mjs <plugin zip or jar>');
  convert(process.argv[2]);
}

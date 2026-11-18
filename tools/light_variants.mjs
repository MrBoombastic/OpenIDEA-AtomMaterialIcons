// Generates light-theme variants for single-variant icons whose bright fills were designed for
// dark backgrounds and wash out on light themes. The original bright SVG becomes the `_dark`
// variant; a hue-preserving darkened copy takes the base (light) slot, matching the port's
// existing light/dark convention (base = light, `_dark` = dark).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// WCAG contrast target for graphical objects on light surfaces.
export const MIN_CONTRAST = 3;
const LIGHT_BGS = ['#ffffff', '#e8e8e8'];

export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
const toHex = rgb => '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

export function luminance(rgb) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const [r, g, b] = rgb.map(f);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(hexA, hexB) {
  const [l1, l2] = [luminance(hexToRgb(hexA)), luminance(hexToRgb(hexB))].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}
const minLightContrast = hex => Math.min(...LIGHT_BGS.map(bg => contrast(hex, bg)));

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = t => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => v * 255);
}

// Near-white fills are inner glyphs/details drawn on top of a coloured badge, not on the theme
// background; darkening them would ruin two-tone icons, so they are left alone.
export function isNearWhite(hex) {
  return rgbToHsl(hexToRgb(hex))[2] > 0.9;
}

// Keep hue and saturation, lower lightness just enough to reach MIN_CONTRAST on light surfaces.
export function darkenHex(hex) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  let lo = 0, hi = l;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (minLightContrast(toHex(hslToRgb([h, s, mid]))) >= MIN_CONTRAST) lo = mid; else hi = mid;
  }
  return toHex(hslToRgb([h, s, lo]));
}

const COLOR_ATTR = /\b(fill|stroke|stop-color)\s*=\s*"(#[0-9a-fA-F]{3,8})"/g;
export function svgColors(svg) {
  const out = new Set();
  for (const [, , value] of svg.matchAll(COLOR_ATTR)) out.add(value.toLowerCase());
  return [...out];
}

// Darken every exposed bright colour in the SVG; returns null when nothing needed changing.
export function darkenSvg(svg) {
  let changed = false;
  const out = svg.replace(COLOR_ATTR, (whole, attr, value) => {
    const hex = value.toLowerCase();
    if (hex.length === 8) return whole; // ignore alpha colours
    if (isNearWhite(hex) || minLightContrast(hex) >= MIN_CONTRAST) return whole;
    changed = true;
    return `${attr}="${darkenHex(hex)}"`;
  });
  return changed ? out : null;
}

const darkPath = light => light.replace(/\.svg$/, '_dark.svg');

export function applyLightVariants(dir = root) {
  const themePath = resolve(dir, 'icons/theme.json');
  const theme = JSON.parse(readFileSync(themePath, 'utf8'));
  const definitions = theme.iconDefinitions;
  let added = 0;
  for (const [id, definition] of Object.entries(definitions)) {
    if (typeof definition === 'string') {
      const light = definition;
      const svg = readFileSync(resolve(dir, light), 'utf8');
      const darkened = darkenSvg(svg);
      if (!darkened) continue;
      const dark = darkPath(light);
      writeFileSync(resolve(dir, dark), svg);        // original bright -> dark variant
      writeFileSync(resolve(dir, light), darkened);  // darkened -> light (base)
      definitions[id] = { light, dark };
      added++;
    } else {
      // Existing pair whose light base is still too pale: darken it in place.
      const darkened = darkenSvg(readFileSync(resolve(dir, definition.light), 'utf8'));
      if (darkened) writeFileSync(resolve(dir, definition.light), darkened);
    }
  }
  writeFileSync(themePath, JSON.stringify(theme, null, 2) + '\n');
  syncManifest(dir, definitions);
  return added;
}

// Keep the generated [[contributes.fileIcons]] block in plugin.toml in sync (iconDark for new pairs).
function syncManifest(dir, definitions) {
  const rules = JSON.parse(readFileSync(resolve(dir, 'rules/path-icons.json'), 'utf8'));
  const ids = [...new Set(rules.rules.map(([, , icon]) => icon).filter(Boolean))].sort();
  const manifestPath = resolve(dir, 'plugin.toml');
  const begin = '# BEGIN generated by tools/convert_atom_material.mjs: icons for path rules\n';
  const end = '# END generated\n';
  const entries = ids.map(id => {
    const definition = definitions[id];
    const { light, dark } = typeof definition === 'string' ? { light: definition } : definition;
    return `[[contributes.fileIcons]]\nid = "${id}"\nicon = "${light}"\n${dark ? `iconDark = "${dark}"\n` : ''}`;
  });
  const manifest = readFileSync(manifestPath, 'utf8').replace(/\r\n/g, '\n');
  const start = manifest.indexOf(begin);
  const stop = manifest.indexOf(end);
  if (start < 0 || stop <= start) return;
  writeFileSync(manifestPath, manifest.slice(0, start) + begin + entries.join('\n') + '\n' + end + manifest.slice(stop + end.length));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const added = applyLightVariants();
  console.log(`Light variants added: ${added}`);
}
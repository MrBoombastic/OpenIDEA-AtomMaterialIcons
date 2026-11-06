# Atom Material Icons for OpenIDEA

[Atom Material Icons](https://github.com/mallowigi/a-file-icon-idea) by Elior "Mallowigi" Boukhobza, ported from IntelliJ to OpenIDEA by MrBoombastic.

The port includes file and folder icons, light/dark variants and folder-specific open icons. Requires **OpenIDEA 0.1.37 or newer**.

The manifest requires plugin API **1.1**, shipped with OpenIDEA 0.1.37. The port's own version starts at **1.0.0**.

## Install

Install `mrboombastic.atom-material-icons-1.0.1.oiplugin` from disk in OpenIDEA's plugin settings, then select **Atom Material Icons** as the icon theme.

The theme settings let you show or hide file and folder icons. Enable **Hollow folders** to use open icons for folders containing a file open in the editor.

## Versions

| Port version | Based on Atom Material Icons | Tested with OpenIDEA | Included | Missing from the original |
| --- | --- | --- | --- | --- |
| **1.0.1** | **210.0.2** | **0.1.38** | Same as 1.0.0, plus Svelte file icons | Same as 1.0.0 |
| **1.0.0** | **210.0.2** | **0.1.37** | 2497 file/folder SVGs, including 47 dark variants; file and folder matching; open-folder icons; visibility settings | Koka icons, 44 file regexes, UI icons and IntelliJ-specific settings and type-based matching. Details below. |

## What's included

- 2450 icon definitions, with 47 light/dark pairs: 2497 of the original 2499 file and folder SVGs.
- 1094 file regexes, 1253 extensions and 1842 exact file names.
- All 346 folder regexes and 2686 exact folder names.

One source rule can produce several extension or name mappings, so these counts don't correspond one-to-one with the original rules.

## What's missing or different

- **44 file regexes:** OpenIDEA rejects them. Files that need these rules may get a more generic icon, although their exact-name mappings are kept where possible. See [the excluded patterns and reasons](tools/unsupported-patterns.json).
- **Koka:** both `koka.svg` and `koka_dark.svg` exceed OpenIDEA's 64 KiB limit per SVG.
- **UI and type-based icons:** the original's 505 UI SVGs are not included. IntelliJ file-type and PSI rules are not ported, so OpenIDEA uses its own icons in those places.
- **Folder state:** open icons follow OpenIDEA's **Hollow folders** setting, rather than IntelliJ's folder-state rules. Expanded folders without a matching rule use a generic icon.
- **Customization:** custom associations, per-rule switches and colour settings are not ported. Icons use the supplied SVG colours; XML colour overrides are ignored. Rules marked `defaultState="false"` in the original are included if supported, so some optional associations are active here.
- **Fixed source patterns:** the original's Svelte regex never matches plain `.svelte` files (IntelliJ uses the Svelte file type instead), so the port corrects it. Fixes are listed in `PATTERN_FIXES` in [the converter](tools/convert_atom_material.mjs).
- **Matching:** names and regexes are case-insensitive. Regexes run before exact names and extensions, with higher-priority source regexes first. Results can differ from IntelliJ.

## Build

You need Node.js and the `openidea-plugin` CLI from OpenIDEA 0.1.37 or newer. Updating the IDE does not update a separately installed CLI.

Run these commands from the project directory:

```powershell
npm ci --ignore-scripts
npm run convert -- 'C:\path\to\a-file-icon-idea-210.0.2.jar'
npm run check
openidea-plugin check .
openidea-plugin pack . --out mrboombastic.atom-material-icons-1.0.1.oiplugin
openidea-plugin check mrboombastic.atom-material-icons-1.0.1.oiplugin
```

For development, link the directory instead of installing a package:

```powershell
openidea-plugin link .
```

## License

[MIT](LICENSE), as in the [original plugin](https://github.com/mallowigi/a-file-icon-idea/blob/master/LICENSE).

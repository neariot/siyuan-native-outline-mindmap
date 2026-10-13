# Native Outline & Mindmap

Edit the lists in your SiYuan documents as an **outline** or a **mindmap** — the data
stays SiYuan's own; the plugin just draws it differently.

## Usage

**Desktop**

1. Open a document (lists work best).
2. Click the **mindmap icon** in the lower half of the right sidebar.

   > Where it sits depends on which other plugins you have installed —
   > go by the icon, not by counting positions.

3. Switch between **Outline** and **Mindmap** at the top; the toolbar edits content
   directly.

**Mobile**

1. Open a document → tap **More** (`⋯`) at the far right of the bottom toolbar.
2. Scroll to the **Plugins** group → tap **Native Outline & Mindmap - Mindmap**.

**Embed a map in the body**

Type `/` in a document → **Insert mindmap**. This inserts an inline block that scrolls
with the document and is included on export.

👉 **[Getting started](docs/GETTING-STARTED.md)** — full steps, annotated UI, keyboard
shortcuts and touch gestures, with screenshots and a screen recording.

## Features

- **Outline**: unlimited depth, Tab indentation, multi-select, focus and breadcrumbs,
  find and replace
- **Mindmap**: 6 structures × 8 themes × 3 line styles, 7 node shapes, branch focus,
  PNG / Freemind export
- **Live two-way sync**: SiYuan → view, and view → SiYuan
- **Works on mobile**: bottom toolbar → More → Plugins

## How it works

Nodes *are* the list items in your SiYuan document. The plugin creates no private
replica, writes no custom attributes, and does no format conversion. Therefore:

| Check | Result |
|---|---|
| Block attributes (`attributes` table) | **0 rows** |
| Open the document after uninstalling | an ordinary list, still fully editable |
| Full-text search for map nodes | **found** (nodes are body text) |
| Edit a block in SiYuan, then open the map | **synced automatically** (no cache) |
| Tasks / headings / notes | native SiYuan task lists / H1–H6 / attached paragraphs |

Compared with the "export to an image / private format" approach, map content stays
**searchable**, there is no second copy, and the document remains readable after
uninstalling. All of this is **verifiable yourself**: create a document, edit a few
nodes, then query the `attributes` table.

- **Safe by design**: incremental write-back (never a whole-document replacement, which
  would rebuild block IDs and destroy references / backlinks), deletion gate,
  echo suppression, conflict baseline, and one-click recovery

## UI language

All interface strings go through i18n and follow SiYuan's language setting:

| SiYuan language | Interface |
|---|---|
| 简体中文 | Chinese |
| English | English |
| Anything else | falls back to English |

Strings live in `src/plugin/i18n/` (`zh_CN.json` / `en_US.json`, both required).

## Build

```bash
npm ci
npm run build      # output in dist-plugin/
```

The build produces a SiYuan plugin (CommonJS, `siyuan` as an external, no HTML).
There is no target switch — building means building the plugin.

## Layout

```
src/
  plugin/        plugin entry, mount layer, sync, i18n
    outline/     outliner UI (React)
  mindmap/       mindmap canvas (React, SVG)
  core/          pure logic: layout, theme, block<->tree mapping
  model/         node model and tree utilities
  siyuan/        kernel API adapter and store layer
  styles.css
docs/            architecture, data format, features, shortcuts, mapping
```

## Docs

- **[Getting started](docs/GETTING-STARTED.md)** — install to first use, with desktop & mobile walkthroughs
- [Shortcuts](docs/SHORTCUTS.md)
- [Features](docs/FEATURES.md)
- [Block mapping](docs/MAPPING.md)
- [Data format](docs/DATA-FORMAT.md)
- [Architecture](docs/ARCHITECTURE.md)

## Notice

This project is an **independent third-party** view editor and is **not affiliated
with** the SiYuan team. Ownership and storage of your data always remain with the
SiYuan library; please keep your regular backups.

Licensed under the [MIT License](LICENSE).

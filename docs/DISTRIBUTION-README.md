# Native Outline & Mindmap (原生大纲导图)

A SiYuan plugin that edits a document's block structure in two views —— an **outline** and a **mind map** ——
and stores everything in SiYuan's own carriers. No side files, no invented attributes, no separate
"plugin storage" to keep in sync.

## Install

Download `package.zip` from the [latest release](https://github.com/neariot/siyuan-native-outline-mindmap/releases/latest)
and add it in SiYuan under **Settings → Marketplace → Install from package**, or unzip it into
`<workspace>/data/plugins/`.

## What it does

* **Outline view** —— the document as a tree: Enter creates a sibling at the same level, Tab indents,
  Shift+Tab outdents (nested means "child" in the data, not just a wider margin).
* **Mind map view** —— the same tree as a map, with the layout and theme you choose. Node labels wrap
  and their boxes grow with the text; nothing is cut short.
* Both views write through SiYuan's own block API, so the document stays the single source of truth and
  remains readable with the plugin disabled.

## Source

The plugin's source code is not published here. This repository exists to distribute the plugin:
releases carry the packaged build, which is what SiYuan installs.

## Issues

Please report problems with a description of what you did, what you expected, and what happened ——
including the SiYuan version and whether the two views disagree.

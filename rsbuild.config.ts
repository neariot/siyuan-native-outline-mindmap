import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import postcssPrefixSelector from 'postcss-prefix-selector';
import { HOST_SCOPE, scopeSelector } from './scripts/css-scope.mjs';

/**
 * A short hash of everything under `src/`, sorted by path.
 *
 * ★ The running bundle has to be identifiable from inside the editor: SiYuan loads a plugin once,
 *   at start-up, with no route to reload it, so "deployed" and "running" can differ. The diagnostic
 *   panel shows this value, and a user can read it in one glance (see `src/types/build-stamp.d.ts`).
 *
 *   Derived from the **source**, not from git: what ships is the working tree, and a commit id says
 *   nothing about uncommitted work. Sorted paths make it stable across filesystems; content changes
 *   change it, which is the only property that matters.
 */
function buildStamp(root = path.join(process.cwd(), 'src')): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  const h = createHash('sha256');
  for (const f of files) {
    h.update(path.relative(root, f));
    h.update(readFileSync(f));
  }
  return h.digest('hex').slice(0, 12);
}

// The only artifact is the SiYuan plugin (CommonJS, `siyuan` external, no HTML).
// There is no TARGET switch -- building *is* the plugin.

const pluginConfig: ReturnType<typeof defineConfig> = defineConfig({
  plugins: [pluginReact()],
  source: {
    entry: {
      // The `!` prefix excludes HTML generation (rsbuild's own syntax).
      // The plugin is a plain JS library: an index.html would mean nothing and would pollute the artifact.
      index: { import: './src/plugin/index.ts', html: false },
    },
    // Replaced in the bundle, so the running code can name the build it came from.
    define: { __OM_BUILD__: JSON.stringify(buildStamp()) },
  },
  output: {
    distPath: {
      root: './dist-plugin',
      js: '.',
      css: '.',
    },
    // SiYuan loads the plugin entry by a fixed file name
    filename: {
      js: 'index.js',
      css: 'index.css',
    },
    // No hashes: SiYuan does not resolve hashed file names
    filenameHash: false,
    // The manifest and i18n ship next to the entry (the kernel reads index.css / i18n/)
    copy: [
      { from: 'src/plugin/plugin.json', to: 'plugin.json' },
      { from: 'src/plugin/i18n', to: 'i18n' },
      // Marketplace icon / preview / readme / licence -- all of them must end up inside package.zip
      { from: 'icon.png', to: 'icon.png' },
      { from: 'preview.png', to: 'preview.png' },
      { from: 'README.md', to: 'README.md' },
      { from: 'README.zh-CN.md', to: 'README.zh-CN.md' },
      { from: 'LICENSE', to: 'LICENSE.txt' },
    ],
    cleanDistPath: true,
    // SiYuan loads the plugin with require(), so it cannot be an IIFE
    library: { type: 'commonjs2' },
  },
  tools: {
    rspack: {
      // SiYuan injects the `siyuan` module at run time -- it must never be bundled
      externals: {
        siyuan: 'commonjs siyuan',
      },
      output: {
        // The point: turn off the default IIFE wrapper so the output is real CJS
        iife: false,
        library: { type: 'commonjs2' },
      },
    },
    // Style scoping: every selector is pulled into `.om-mm-host` at build time.
    // Why the prefix is not written by hand, and how the three special cases are handled: scripts/css-scope.mjs.
    postcss: {
      postcssOptions: {
        plugins: [
          postcssPrefixSelector({
            prefix: HOST_SCOPE,
            transform: (prefix: string, selector: string, prefixed: string) =>
              scopeSelector(selector, prefixed),
          }),
        ],
      },
    },
  },
  performance: {
    // React and everything else is inlined: one file is easier to distribute
    chunkSplit: { strategy: 'all-in-one' },
  },
});

export default pluginConfig;

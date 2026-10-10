import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import postcssPrefixSelector from 'postcss-prefix-selector';
import { HOST_SCOPE, scopeSelector } from './scripts/css-scope.mjs';

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

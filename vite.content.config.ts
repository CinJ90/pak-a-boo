import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// The content script is built SEPARATELY from popup + background, as a single IIFE.
// The main build (vite.config.ts) bundles those two as ES modules and hoists whatever
// they share (types, the skin registry, the ghost rig) into dist/chunks/*.js — which a
// content script cannot load: Chrome injects it as a classic script, and a bare
// `import` there is a syntax error. Building it alone in lib/iife mode inlines every
// import, so content.ts can share src/ghost.ts and src/skins.ts with the popup instead
// of carrying its own copy of the art and the unlock rules.
//
// Runs AFTER the main build (see package.json), with emptyOutDir off so it adds to dist
// rather than wiping it.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(root, 'src/content.ts'),
      formats: ['iife'],
      name: 'PakABoo',
      fileName: () => 'content.js'
    },
    rollupOptions: {
      output: { extend: true }
    }
  }
});

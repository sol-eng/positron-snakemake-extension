// @ts-check
import * as esbuild from 'esbuild';
import * as fs from 'fs';

esbuild.buildSync({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode', 'node'],
  format: 'cjs',
  minify: true
});

// Positron: the Viewer pages that draw workflow graphs load mermaid from here
fs.mkdirSync('dist/media', { recursive: true });
fs.copyFileSync('node_modules/mermaid/dist/mermaid.min.js', 'dist/media/mermaid.min.js');

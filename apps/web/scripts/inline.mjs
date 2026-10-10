// Produce a single self-contained HTML file (the live demo) from `vite build --mode single`.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../dist-single/', import.meta.url).pathname;
let html = readFileSync(join(dir, 'index.html'), 'utf8');
html = html.replace(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/g, (_m, f) => {
  const js = readFileSync(join(dir, f), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/g, (_m, f) => `<style>${readFileSync(join(dir, f), 'utf8')}</style>`);
if (/src="\.\/assets|href="\.\/assets/.test(html)) throw new Error('some assets were not inlined');
writeFileSync(join(dir, 'kernelcraft.html'), html);
console.log(`dist-single/kernelcraft.html  ${(html.length / 1024).toFixed(0)} kB  (${readdirSync(join(dir, 'assets')).length} assets inlined)`);

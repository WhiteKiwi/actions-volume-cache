import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts', 'src/post.ts'],
  outdir: 'dist',
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  sourcemap: false,
  legalComments: 'eof',
});

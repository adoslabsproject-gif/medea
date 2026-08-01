import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/admission/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  minify: false,
  target: 'node22',
});

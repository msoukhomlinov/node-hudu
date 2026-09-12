import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/resources/index.ts', 'src/types/index.ts', 'src/errors.ts', 'src/capabilities.ts', 'src/operations/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  target: 'node18',
  outDir: 'dist',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});

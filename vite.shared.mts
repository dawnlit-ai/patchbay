import { resolve } from 'node:path';

// Mirrors tsconfig's `paths`. Imported as `./vite.shared.mjs`, since tsc and
// esbuild reject a `.mts` import but map the `.mjs` back to this file.
export const alias = { '@shared': resolve(import.meta.dirname, 'src/shared') };

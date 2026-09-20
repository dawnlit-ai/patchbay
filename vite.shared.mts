import { resolve } from 'node:path';

// Every bundle resolves `@shared` for itself; tsconfig's `paths` is the same
// mapping written again for the editor and `tsc`. The configs import this as
// `./vite.shared.mjs` — the built extension, which both tsc and esbuild map
// back to this file; naming the .mts directly is what they reject.
export const alias = { '@shared': resolve(import.meta.dirname, 'src/shared') };

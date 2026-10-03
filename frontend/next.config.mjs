import { fileURLToPath } from 'node:url';

export default {
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
};

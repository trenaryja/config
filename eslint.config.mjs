// TODO: rename to eslint.config.ts (here and in tren's ESLINT_FILES) once ESLint loads a TS config under Node without jiti, i.e. drops the isFileTS -> jiti branch in eslint/lib/config/config-loader.js
import { defineConfig } from '@trenaryja/config/eslint'

export default defineConfig()

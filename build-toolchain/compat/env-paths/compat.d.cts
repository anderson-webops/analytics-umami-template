import type * as modern from './index.js' with { 'resolution-mode': 'import' }

declare const envPaths: typeof modern.default & typeof modern
export = envPaths

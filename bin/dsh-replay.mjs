#!/usr/bin/env node
// Thin launcher so the npm bin works from source through tsx.
import 'tsx/esm'
await import('../src/cli/index.ts')

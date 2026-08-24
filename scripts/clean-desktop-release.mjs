#!/usr/bin/env node

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

rmSync(resolve(rootDir, 'desktop', 'release'), { force: true, recursive: true });

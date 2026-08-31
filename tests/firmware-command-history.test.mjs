import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const testsDir = dirname(fileURLToPath(import.meta.url));
const source = join(testsDir, 'firmware-command-history.test.cpp');
const buildDir = await mkdtemp(join(tmpdir(), 'sfab-command-history-'));
const binary = join(buildDir, 'command-history-test');

try {
    await run('c++', ['-std=c++11', '-Wall', '-Wextra', '-Werror', source, '-o', binary]);
    await run(binary);
    console.log('firmware command history regression passed');
} finally {
    await rm(buildDir, { recursive: true, force: true });
}

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const toolchain = 'go1.27.2';
const version = spawnSync('go', ['version'], { encoding: 'utf8' });
if (version.error || version.status !== 0 || version.stdout.split(' ')[2] !== toolchain)
  throw new Error(`Building distributables requires ${toolchain} on PATH`);
await fs.mkdir('dist/bin', { recursive: true });
const manifest = { go: toolchain, files: {} };
for (const [arch, goarch] of [
  ['x64', 'amd64'],
  ['arm64', 'arm64'],
]) {
  const output = `dist/bin/lock-linux-${arch}`;
  const result = spawnSync(
    'go',
    [
      'build',
      '-trimpath',
      '-buildvcs=false',
      '-ldflags=-s -w -buildid=',
      '-o',
      path.resolve(output),
      '.',
    ],
    {
      cwd: 'lock-helper',
      stdio: 'inherit',
      env: {
        ...process.env,
        GOTOOLCHAIN: 'local',
        GOWORK: 'off',
        GOENV: 'off',
        GOFLAGS: '',
        GOEXPERIMENT: '',
        CGO_ENABLED: '0',
        GOOS: 'linux',
        GOARCH: goarch,
        GOAMD64: 'v1',
        GOARM64: 'v8.0',
        GOCACHE: path.resolve('.cache/go-build'),
        GOMODCACHE: path.resolve('.cache/go-mod'),
      },
    },
  );
  if (result.error || result.status !== 0) throw new Error(`Cannot build ${output}`);
  await fs.chmod(output, 0o755);
  manifest.files[path.basename(output)] = createHash('sha256')
    .update(await fs.readFile(output))
    .digest('hex');
}
const goroot = spawnSync('go', ['env', 'GOROOT'], { encoding: 'utf8' });
if (goroot.status !== 0) throw new Error('Cannot locate Go runtime license');
await fs.copyFile(path.join(goroot.stdout.trim(), 'LICENSE'), 'dist/bin/LICENSE-Go.txt');
await fs.writeFile('dist/bin/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

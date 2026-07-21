// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const linuxFix = require('./linux-fix.js').default;
const linuxOnlyIt = process.platform === 'linux' ? it : it.skip;
const temporaryDirectories = new Set();
const debianAfterInstall = fs.readFileSync(
  path.join(process.cwd(), 'scripts', 'deb-after-install.tpl'),
  'utf8',
);

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function installTestLauncher() {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-deb-'));
  temporaryDirectories.add(appOutDir);
  const executablePath = path.join(appOutDir, 'video-swarm');
  fs.writeFileSync(executablePath, '#!/bin/bash\nprintf \'%s\\0\' "$@"\n');
  fs.chmodSync(executablePath, 0o755);
  return { appOutDir, executablePath };
}

function runLauncher(executablePath, args, environment = {}) {
  const childEnvironment = { ...process.env, ...environment };
  if (!Object.hasOwn(environment, 'VIDEOSWARM_DISABLE_SANDBOX')) {
    delete childEnvironment.VIDEOSWARM_DISABLE_SANDBOX;
  }

  const result = spawnSync(executablePath, args, {
    encoding: 'buffer',
    env: childEnvironment,
  });

  return {
    ...result,
    args: result.stdout.toString().split('\0').filter(Boolean),
    stderrText: result.stderr.toString(),
  };
}

describe('packaged Debian launcher', () => {
  linuxOnlyIt('runs the packaged executable with sandboxing on by default', async () => {
    const { appOutDir, executablePath } = installTestLauncher();

    await linuxFix({ electronPlatformName: 'linux', appOutDir });

    const result = runLauncher(executablePath, ['--example', 'two words']);
    expect(result.status).toBe(0);
    expect(result.args).toEqual(['--example', 'two words']);
    expect(result.stderrText).toBe('');
    expect(fs.existsSync(`${executablePath}-bin`)).toBe(true);
    expect(fs.statSync(executablePath).mode & 0o777).toBe(0o755);
  });

  linuxOnlyIt('only disables the sandbox through the explicit compatibility escape hatch', async () => {
    const { appOutDir, executablePath } = installTestLauncher();

    await linuxFix({ electronPlatformName: 'linux', appOutDir });

    const result = runLauncher(
      executablePath,
      ['--example'],
      { VIDEOSWARM_DISABLE_SANDBOX: '1' },
    );
    expect(result.status).toBe(0);
    expect(result.args).toEqual([
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--example',
    ]);
    expect(result.stderrText).toContain('Chromium OS sandbox disabled');
  });

  linuxOnlyIt('resolves the symlink used by an installed Debian command', async () => {
    const { appOutDir, executablePath } = installTestLauncher();
    const commandDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-bin-'));
    temporaryDirectories.add(commandDirectory);
    const installedCommand = path.join(commandDirectory, 'video-swarm');

    await linuxFix({ electronPlatformName: 'linux', appOutDir });
    fs.symlinkSync(path.relative(commandDirectory, executablePath), installedCommand);

    const result = runLauncher(installedCommand, ['--from-deb-command']);
    expect(result.status).toBe(0);
    expect(result.args).toEqual(['--from-deb-command']);
  });

  it('writes a launcher that documents the opt-in compatibility path', async () => {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-pack-'));
    temporaryDirectories.add(appOutDir);
    const executablePath = path.join(appOutDir, 'video-swarm');
    fs.writeFileSync(executablePath, '#!/bin/bash\nexit 0\n');
    fs.chmodSync(executablePath, 0o755);

    await linuxFix({ electronPlatformName: 'linux', appOutDir });

    const wrapper = fs.readFileSync(executablePath, 'utf8');
    expect(wrapper).toContain('VIDEOSWARM_DISABLE_SANDBOX');
    expect(wrapper).toContain('sandbox_args+=(--no-sandbox --disable-setuid-sandbox)');
    expect(wrapper).toContain('"${sandbox_args[@]}"');
    expect(wrapper).toContain('while [[ -L "$launcher_path" ]]');
  });

  it('leaves non-Linux packages unchanged', async () => {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-pack-'));
    temporaryDirectories.add(appOutDir);
    const executablePath = path.join(appOutDir, 'video-swarm');
    fs.writeFileSync(executablePath, 'original');

    await linuxFix({ electronPlatformName: 'win32', appOutDir });

    expect(fs.readFileSync(executablePath, 'utf8')).toBe('original');
    expect(fs.existsSync(`${executablePath}-bin`)).toBe(false);
  });
});

describe('Debian post-install sandbox contract', () => {
  it('configures the installed Chromium helper as root-owned SUID', () => {
    expect(debianAfterInstall).toContain('set -e');
    expect(debianAfterInstall).toContain('chown root:root -- "$sandbox_path"');
    expect(debianAfterInstall).toContain('chmod 4755 -- "$sandbox_path"');
    expect(debianAfterInstall).toContain("!= '0:0:4755'");
    expect(debianAfterInstall).not.toMatch(
      /(?:chown root:root|chmod 4755)[^\n]*\|\| true/,
    );
  });

  it('preserves command registration and desktop database refreshes', () => {
    expect(debianAfterInstall).toContain('update-alternatives');
    expect(debianAfterInstall).toContain('update-mime-database');
    expect(debianAfterInstall).toContain('update-desktop-database');
  });

  linuxOnlyIt('uses only supported builder macros and renders as valid Bash', () => {
    const macros = Array.from(
      debianAfterInstall.matchAll(/\$\{([a-zA-Z]+)\}/g),
      (match) => match[1],
    );
    expect(new Set(macros)).toEqual(
      new Set(['executable', 'sanitizedProductName']),
    );

    const renderedScript = debianAfterInstall
      .replaceAll('${executable}', 'video-swarm')
      .replaceAll('${sanitizedProductName}', 'VideoSwarm');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-postinst-'));
    temporaryDirectories.add(directory);
    const scriptPath = path.join(directory, 'postinst');
    fs.writeFileSync(scriptPath, renderedScript);

    expect(spawnSync('bash', ['-n', scriptPath]).status).toBe(0);
  });
});

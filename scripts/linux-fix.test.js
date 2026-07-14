// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const linuxFix = require('./linux-fix.js').default;
const temporaryDirectories = new Set();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe('packaged Linux launcher', () => {
  it('keeps the Chromium sandbox on unless the user explicitly opts out', async () => {
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
    expect(fs.existsSync(`${executablePath}-bin`)).toBe(true);
    expect(fs.statSync(executablePath).mode & 0o777).toBe(0o755);
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

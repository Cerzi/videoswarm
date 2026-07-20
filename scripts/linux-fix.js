const fs = require('fs');
const path = require('path');

const EXECUTABLE_NAME = 'video-swarm';

function createDebianLauncherScript(executableName = EXECUTABLE_NAME) {
  return `#!/bin/bash
set -e

# Resolve the installed /usr/bin symlink before looking for the packaged
# executable. Debian packages place the application itself under /opt.
launcher_path="${'${BASH_SOURCE[0]}'}"
while [[ -L "$launcher_path" ]]; do
  launcher_dir="$(cd -P "$(dirname "$launcher_path")" >/dev/null 2>&1 && pwd)"
  launcher_path="$(readlink "$launcher_path")"
  if [[ "$launcher_path" != /* ]]; then
    launcher_path="$launcher_dir/$launcher_path"
  fi
done
launcher_dir="$(cd -P "$(dirname "$launcher_path")" >/dev/null 2>&1 && pwd)"

sandbox_args=()
if [[ "${'${VIDEOSWARM_DISABLE_SANDBOX:-0}'}" == "1" ]]; then
  echo "Video Swarm warning: Chromium OS sandbox disabled by VIDEOSWARM_DISABLE_SANDBOX=1" >&2
  sandbox_args+=(--no-sandbox --disable-setuid-sandbox)
fi

exec "$launcher_dir/${executableName}-bin" "${'${sandbox_args[@]}'}" "$@"
`;
}

exports.default = async function(context) {
  if (context.electronPlatformName === 'linux') {
    const appOutDir = context.appOutDir;
    const executablePath = path.join(appOutDir, EXECUTABLE_NAME);

    console.log('Installing sandbox-preserving Debian launcher at:', executablePath);

    fs.renameSync(executablePath, executablePath + '-bin');
    fs.writeFileSync(executablePath, createDebianLauncherScript());
    fs.chmodSync(executablePath, 0o755);

    console.log('Debian launcher installed with sandboxing enabled by default');
  }
};

exports.createDebianLauncherScript = createDebianLauncherScript;

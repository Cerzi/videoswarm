const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
  console.log('Installing Linux launcher wrapper...');
  
  if (context.electronPlatformName === 'linux') {
    const appOutDir = context.appOutDir;
    const executableName = 'video-swarm'; // Match the executableName in package.json
    const executablePath = path.join(appOutDir, executableName);
    
    console.log('Installing secure launcher at:', executablePath);
    
    // Rename original executable
    fs.renameSync(executablePath, executablePath + '-bin');
    
    // Create wrapper script
    const wrapperScript = `#!/bin/bash
set -e

launcher_dir="$(cd "$(dirname "$0")" && pwd)"
sandbox_args=()
if [[ "${'${VIDEOSWARM_DISABLE_SANDBOX:-0}'}" == "1" ]]; then
  echo "Video Swarm warning: Chromium OS sandbox disabled by VIDEOSWARM_DISABLE_SANDBOX=1" >&2
  sandbox_args+=(--no-sandbox --disable-setuid-sandbox)
fi

exec "$launcher_dir/${executableName}-bin" "${'${sandbox_args[@]}'}" "$@"
`;
    
    fs.writeFileSync(executablePath, wrapperScript);
    fs.chmodSync(executablePath, 0o755);
    
    console.log('Linux launcher installed with sandboxing enabled by default');
  }
};

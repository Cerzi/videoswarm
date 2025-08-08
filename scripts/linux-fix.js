const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
  console.log('Running Linux sandbox fix...');
  
  if (context.electronPlatformName === 'linux') {
    const appOutDir = context.appOutDir;
    const executableName = 'video-swarm'; // Match the executableName in package.json
    const executablePath = path.join(appOutDir, executableName);
    
    console.log('Applying sandbox fix to:', executablePath);
    
    // Rename original executable
    fs.renameSync(executablePath, executablePath + '-bin');
    
    // Create wrapper script
    const wrapperScript = `#!/bin/bash
exec "$(dirname "$0")/${executableName}-bin" --no-sandbox --disable-setuid-sandbox "$@"
`;
    
    fs.writeFileSync(executablePath, wrapperScript);
    fs.chmodSync(executablePath, 0o755);
    
    console.log('Linux sandbox fix applied successfully');
  }
};
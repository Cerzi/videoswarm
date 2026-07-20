#!/bin/bash
set -e

executable='${executable}'
install_path='/opt/${sanitizedProductName}/${executable}'
sandbox_path='/opt/${sanitizedProductName}/chrome-sandbox'

# Chromium's SUID sandbox is the supported sandbox on hardened Ubuntu hosts.
# Do not expose an installed command unless the helper is a real packaged file
# with the exact ownership and mode Chromium requires.
if [ ! -f "$sandbox_path" ] || [ -L "$sandbox_path" ]; then
    echo "Video Swarm installation failed: Chromium sandbox helper is missing or invalid: $sandbox_path" >&2
    exit 1
fi

chown root:root -- "$sandbox_path"
chmod 4755 -- "$sandbox_path"

sandbox_state="$(stat -c '%u:%g:%a' -- "$sandbox_path")"
if [ "$sandbox_state" != '0:0:4755' ]; then
    echo "Video Swarm installation failed: Chromium sandbox helper has $sandbox_state; expected 0:0:4755" >&2
    exit 1
fi

if command -v update-alternatives >/dev/null 2>&1; then
    # Remove a legacy direct link before registering the packaged launcher.
    if [ -L "/usr/bin/$executable" ] && \
       [ -e "/usr/bin/$executable" ] && \
       [ "$(readlink "/usr/bin/$executable")" != "/etc/alternatives/$executable" ]; then
        rm -f "/usr/bin/$executable"
    fi

    update-alternatives \
        --install "/usr/bin/$executable" "$executable" "$install_path" 100 || \
        ln -sf "$install_path" "/usr/bin/$executable"
else
    ln -sf "$install_path" "/usr/bin/$executable"
fi

if command -v update-mime-database >/dev/null 2>&1; then
    update-mime-database /usr/share/mime || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi

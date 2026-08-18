# Linux Debian Package Troubleshooting

Video Swarm's supported Linux release is the Debian/Ubuntu x64 `.deb`. The
package installs under `/opt/VideoSwarm`, registers `/usr/bin/video-swarm`, and
configures Chromium's SUID sandbox helper as `root:root` with mode `4755`.
Portable AppImages and production `--no-sandbox` launches are not supported.

## Verify what actually installed

`apt` operates on the whole pending package transaction, not only the `.deb`
named on its command line. It can successfully configure Video Swarm and then
exit nonzero while retrying an unrelated half-configured kernel, DKMS driver,
or other system package.

Before treating the final exit status as a Video Swarm packaging failure, run:

```bash
dpkg-query -W -f='${db:Status-Abbrev} ${Version}\n' video-swarm
stat -c '%U:%G %a %n' /opt/VideoSwarm/chrome-sandbox
readlink -f /usr/bin/video-swarm
```

A successful installation reports:

- a package-status abbreviation beginning with `ii`;
- `root:root 4755 /opt/VideoSwarm/chrome-sandbox`; and
- `/opt/VideoSwarm/video-swarm` as the registered launcher.

The Debian-normalized package version may contain `~rc` even though the
downloaded filename and application version use `-rc`; for example,
`0.6.0~rc.5` and `0.6.0-rc.5` identify the same release candidate.

If those checks pass, launch the installed application with:

```bash
video-swarm
```

## Distinguish host package failures

Inspect the pending system state and the final package names in the original
install output:

```bash
dpkg --audit
```

If the log already contains `Setting up video-swarm`, Video Swarm has status
`ii`, and the only failures name packages such as `linux-image`,
`linux-headers`, DKMS, or a GPU driver, repair that host package transaction
using guidance for the installed distribution and driver. Reinstalling Video
Swarm will only cause `apt` to retry the same pending work.

Preserve the currently working kernel and driver until the package database is
healthy and a repaired configuration has booted successfully. Do not respond
to an unrelated DKMS failure by running `apt autoremove`, deleting working
kernels, or disabling Chromium's sandbox.

This informational line is not a failure by itself:

```text
N: Download is performed unsandboxed as root ... couldn't be accessed by user '_apt'
```

It means the `_apt` account could not traverse the directory containing the
local download. If desired, place the `.deb` in a directory readable by `_apt`
before installing it; diagnose the command from the later `E:`/`dpkg:` errors
and package status, not from that notice.

## Identify a real Video Swarm package failure

Treat the result as a Video Swarm packaging problem when one or more of these
conditions holds:

- `video-swarm` is not installed with status `ii`;
- the failing package named by `dpkg` is `video-swarm`;
- the post-install script reports that `chrome-sandbox` is missing, invalid,
  or cannot be set to `root:root 4755`;
- `/usr/bin/video-swarm` does not resolve to the packaged launcher; or
- the verified package cannot launch normally without a no-sandbox flag.

Attach the complete installation output plus the three verification commands
above to a bug report. Remove private paths or filenames before posting.

## Maintainer triage contract

The CI and tag-release workflows build exactly one Linux `.deb`, install that
artifact on Ubuntu, assert the sandbox helper's ownership and mode, and launch
the installed command with Chromium sandboxing enabled. When investigating an
install report:

1. establish the `video-swarm` dpkg status before changing packaging code;
2. separate the first failing package from apt's final transaction summary;
3. verify the installed launcher and sandbox helper;
4. compare the result with the installed-package CI smoke test; and
5. avoid encoding a host-specific kernel or driver transition as an application
   dependency or permanent repair command.

Restricted containers and agent sandboxes can map host UID/GID `0` to
`nobody:nogroup`. If that happens, repeat the ownership check in the host
namespace or use the installed-package CI result; do not weaken the
`root:root 4755` release contract because of a remapped filesystem view.

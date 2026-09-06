# Deployment dependencies

`seccomp_profile.json` is adapted from Microsoft Playwright v1.63.0:
https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json

Copyright Microsoft Corporation. Licensed under Apache License 2.0; see
`PLAYWRIGHT-LICENSE`. The profile enables the user namespaces Chromium's sandbox
needs while retaining Docker's syscall filtering. Review it against your host
kernel and security policy before deploying.

Launch Inspector adds an explicit `chroot` syscall allowance. The outer container
drops all capabilities, so the upstream conditional CAP_SYS_CHROOT rule would
block Chromium's chroot operation inside its own user namespace. This allowance
does not grant CAP_SYS_CHROOT to the outer container; Chromium remains non-root
with no-new-privileges and its namespace/seccomp sandbox enabled.

Deployment guidance: https://playwright.dev/docs/docker

The Node and Caddy images and all npm dependencies retain their own licenses.

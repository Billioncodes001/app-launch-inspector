# Deployment dependencies

`seccomp_profile.json` is distributed unchanged from Microsoft Playwright v1.63.0:
https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json

Copyright Microsoft Corporation. Licensed under Apache License 2.0; see
`PLAYWRIGHT-LICENSE`. The profile enables the user namespaces Chromium's sandbox
needs while retaining Docker's syscall filtering. Review it against your host
kernel and security policy before deploying.

Deployment guidance: https://playwright.dev/docs/docker

The Node and Caddy images and all npm dependencies retain their own licenses.

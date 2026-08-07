# Takipçi Paneli

## Project overview

This repository contains a pre-built Manifest V3 browser extension in
`safe-extension/panel_fixed/`. It is intended to be loaded unpacked in Chrome,
Edge, or Firefox and interacts with an authenticated Instagram tab.

There is no source build system or web-server entry point in the imported
repository. Replit preview/workflows are therefore not configured by default.

## User preferences

- Keep the existing extension structure and browser-extension stack.
- Prefer conservative, fail-closed behavior for Instagram session and
  rate-limit responses.
- Do not add credentials or invent external service configuration.
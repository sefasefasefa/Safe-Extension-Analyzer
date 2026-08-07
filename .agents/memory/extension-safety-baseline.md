---
name: Extension safety baseline
description: Durable safety constraints for the Instagram browser extension.
---

The extension must not use browser cookie, alarm, window-management, declarative-network, or broad-host permissions. Instagram requests should originate from an open Instagram tab, use endpoint validation, and stop rather than retry after an ambiguous mutation failure.

**Why:** The original extension combined broad permissions, page-wide network interception, periodic automation, and retry/fallback paths that could send duplicate or unexpected requests.

**How to apply:** Preserve request single-flight/cache guards, the automation in-flight lock, conservative normalized limits, sender validation, and the separate safe-extension working copy when making future changes.
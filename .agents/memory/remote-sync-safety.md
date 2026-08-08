---
name: Remote sync safety
description: Safety rule for syncing the browser extension with upstream GitHub changes.
---

Never merge upstream extension changes blindly. Review `tabs.create`, `tabs.update`, cookie mutation, login/logout URLs, and manifest permissions after every remote sync.

**Why:** Upstream commits previously reintroduced background Instagram tabs, forced logout navigation, cookie deletion, and broad CDN permissions after local safety fixes.

**How to apply:** Preserve upstream request/rate-limit improvements when useful, but reapply the navigation and session boundaries before committing or pushing the synced extension.
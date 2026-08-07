---
name: Extension navigation safety
description: Safety boundary for browser-extension cleanup, session handling, and navigation behavior.
---

Browser-extension local cleanup must not delete third-party cookies, redirect existing tabs, or open a login/logout page. Session checks may pause automation, but they should report a neutral state and require the user to keep an Instagram tab open. New tabs or page navigation should only happen as part of an explicit user action.

**Why:** Implicit cookie and navigation side effects caused unexpected Instagram login/logout behavior and could sign the user out across all open tabs.

**How to apply:** Treat extension data clearing as storage-only. Keep session detection fail-closed, remove global click interception, and review every `tabs.create`, `tabs.update`, `cookies.remove`, and `cookies.onChanged` use before adding or changing behavior.
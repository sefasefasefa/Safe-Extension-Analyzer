---
name: Instagram request safety
description: Durable rules for preventing extension request fan-out after Instagram auth or rate-limit signals.
---

The extension must treat authentication failures, rate limits, challenges, and access blocks as whole-tick stop conditions, not candidate-level errors. All request contexts must share the persisted cooldown so an isolated content script cannot continue after the service worker has blocked requests, or vice versa.

**Why:** Instagram can return a valid-looking session cookie while rejecting requests server-side; continuing fallback endpoints or candidates after that signal multiplies traffic and can extend the restriction.

**How to apply:** Any new Instagram fetch, GraphQL mutation, DOM-triggered action, profile refresh, or pagination loop must use the shared request gate and must not retry after explicit 401/403/429, `login_required`, challenge, or feedback-required responses.
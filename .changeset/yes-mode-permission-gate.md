---
"@aliou/pi-guardrails": patch
---

Auto-approve dangerous-command prompts under YES mode: `pi --yes`, `YES=1`, and `/yes on` now bypass both confirm sites (bash pre-exec hook and `guardrails_run_anyway`) because guardrails calls `ctx.ui` methods directly and never saw the yes module's ui patches.

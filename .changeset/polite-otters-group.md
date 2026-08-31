---
"@yurifrl/pi-guardrails": patch
---

Fix session-escalation grouping for built-in dangerous commands. All structurally matched commands (sudo, rm -rf, dd of=, docker run --privileged, …) previously shared a single `"(structural)"` escalation group, so approving two *different* dangerous commands triggered the "Allow this guardrail for this session" offer and a grant auto-approved every built-in dangerous command. Each built-in matcher now carries a stable name (`rm -rf`, `sudo`, …), so the offer is per command family: approving `sudo apt update` twice only offers a session grant for `sudo`.

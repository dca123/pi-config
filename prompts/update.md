---
description: Review a Pi update before installing it
---
Review the available Pi update before I install it.

Do this:
1. Read `~/.pi/agent/settings.json` to find my configured Pi packages.
2. Inspect my active global extensions in `~/.pi/agent/extensions/`.
3. If I am in a project with `.pi/extensions/`, inspect those too.
4. Fetch the current Pi changelog from:
   https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md
5. Summarize the newest release since my current version in three sections:
   - What changed
   - What matters to me
   - Anything I should do after updating
6. Check whether any of my extensions or packages are likely to break.
7. Separate:
   - update-related risks
   - pre-existing extension problems not caused by this update
8. End with:
   - Verdict: Safe / Caution / Hold off
   - Exact install command
   - Any follow-up commands I should run

Be concrete. Quote file paths, APIs, and changelog items when relevant.

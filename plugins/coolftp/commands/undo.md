---
description: Undo the last coolFTP deploy and put the previous version of the site back
---

Undo the last deploy of this project with `coolftp_undo` (pass `cwd` as this project's absolute path). First call it with `dryRun: true` and tell the user in one line what would be restored and removed, then run it for real. If the user named an older deploy, find its id with `coolftp_history` and pass it as `to`. Report the live check that follows. If the coolFTP app denies it, stop.

$ARGUMENTS

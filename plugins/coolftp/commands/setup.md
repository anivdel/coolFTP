---
description: Link this project to your web server with coolFTP (one time)
---

Set this project up to deploy with coolFTP, following the "First time in a project" steps of the coolftp deploy skill. Pass `cwd` as this project's absolute path.

Work out what folder actually gets served (the project root, or a build output such as `dist`) and whether there is a build command, from the project's files, before asking the user anything. Never ask the user to paste a password into this chat; servers are added in the coolFTP app or in their own terminal.

When it is linked, run `coolftp_diff` and tell the user in one line what the first deploy would send, then ask whether to deploy.

$ARGUMENTS

# update-shortcut.ps1 — NO-OP
#
# Dev builds must NOT hijack the desktop shortcut.
# The installed app (via v0.3.0+ NSIS installer) owns the shortcut;
# the auto-updater keeps it current on the same release channel as mom's device.
#
# If you need to point the shortcut elsewhere for debugging, do it manually.
Write-Host '[shortcut] no-op: dev builds do not update the desktop shortcut.'

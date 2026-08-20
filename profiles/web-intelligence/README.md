# Web Intelligence candidate profile

This profile reuses the current Web/App bundles and adds only Host intelligence
modules. It is a staging target, not the default `web` profile.

Validation order:

1. `node verify-profile.mjs --smoke`
2. `dsh --profile web-intelligence --dump-config`
3. `dsh --profile web-intelligence --help`
4. boot on a non-production port and run text/image/tool acceptance
5. compare the approved UI manifest and screenshots
6. only then consider changing the default profile

The tool policy starts in `observe` mode. The Web app leaves global compaction
disabled; Compaction v2 is selected inside reliable-development's isolated
agent realm. This avoids duplicate private service registration.

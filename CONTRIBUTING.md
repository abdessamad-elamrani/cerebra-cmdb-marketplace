# Contributing

## Recommended: Share From Inside Cerebra

Use Cerebra’s in-app export flow whenever possible. It generates the correct pack structure and metadata (including file hashes) and can submit a PR.

1. Build/update your profile in Cerebra (`CmdDB`).
2. Go to `CmdDB` -> `Profile Settings` -> `Marketplace Export`.
3. Choose:
   - `Export + Submit PR` (recommended), or
   - `Export Pack` and submit the PR manually.

See `README.md` section: **Share From Cerebra (Recommended)**.

## Manual Submission (Advanced)

Only use this path if you can’t use Cerebra’s in-app export.

1. Create or update one pack under `packs/<packId>/versions/<version>/`.
2. Bump semver when content changes and update `pack.json` `latestVersion`.
3. Ensure `profile.json` is valid and every command has a string `description`.
4. Ensure graph filenames map to command IDs and graph JSON renders in the app.
5. Update `catalog/index.v1.json` to point to the correct `manifestUrl`.
6. Open a PR with a clear summary (pack id, version, what changed).

## Safety

Never include secrets, tokens, passwords, private targets, or proprietary content.

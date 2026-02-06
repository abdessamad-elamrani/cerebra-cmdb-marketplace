# Cerebra CmDB Marketplace

Community and curated CmDB profile packs for Cerebra.

## Pack Layout

- `catalog/index.v1.json`: app entry catalog
- `packs/<packId>/pack.json`: pack metadata
- `packs/<packId>/versions/<semver>/manifest.v1.json`: signed file map
- `packs/<packId>/versions/<semver>/profile.json`: commands profile
- `packs/<packId>/versions/<semver>/assets/*`: images
- `packs/<packId>/versions/<semver>/graphs/*`: graph sidecars

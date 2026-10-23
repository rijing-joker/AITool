# Graph SCIP Generation

Run:

```bash
npm run graph:scip
```

Output: `index.scip` at repo root.

This script uses `tsconfig.json` (which extends `tsconfig.scip.json`) for indexing. If you need to add more paths, update `tsconfig.scip.json`.

## Graph Auto-Index

Run a dry-run plan:

```bash
npm run graph:auto-index
```

Apply indexing + import (multi-domain when needed):

```bash
npm run graph:auto-index -- --apply
```

Output: `graph.plan.json` at repo root, plus `index.<domain>.scip` files when applied.

## Configuration and validation

`lib/config.cjs` discovers root `tsconfig*.json` files and supplies fixed split thresholds. The plan chooses one index or domain indexes through `lib/domain-discovery.cjs` / `lib/split-decision.cjs`; apply mode validates coverage before `lib/importer.cjs` imports definitions/references into `data/graph.sqlite` (requires the `sqlite3` executable). Temporary per-domain TypeScript configs are generated under `.tmp/graph/auto-index/`.

Use the implementation and `test/graph-*.test.js` for supported behavior. This checkout does not supply a separate SQL query-template catalog.

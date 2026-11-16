#!/bin/bash
# Bundles the cache action (src/cache) into cache/dist, which is committed so
# a workflow can run it, and the runner image's automatic caches into
# runner/dist, then writes the third-party notices for both (NOTICE, and
# runner/dist/NOTICE for the image); CI fails when any of them is stale.
set -euo pipefail
rm -rf cache/dist
bun build src/cache/entry/*.ts --target node --format esm --splitting --minify-syntax \
  --outdir cache/dist --entry-naming '[name].mjs' --chunk-naming 'chunk-[hash].mjs' >/dev/null
bun build src/cache/auto/main.ts --target node --format esm --minify-syntax \
  --outfile runner/dist/auto-cache.mjs >/dev/null
{
  cat <<'NOTICE'
backmesh
Copyright 2026 backmesh

This product is licensed under the Apache License, Version 2.0 (LICENSE).

The cache action (cache/) is licensed under the MIT License (cache/LICENSE).
Its committed bundle, cache/dist, and the runner image's bundle, runner/dist,
include the third-party packages below, under their own licences.
NOTICE
  node scripts/notice.mjs cache/dist/*.mjs runner/dist/*.mjs
} >NOTICE
{
  cat <<'NOTICE'
backmesh runner image
Copyright 2026 backmesh

backmesh is licensed under the Apache License, Version 2.0 (LICENSE, next to
this file). auto-cache.mjs includes the third-party packages below, under
their own licences.
NOTICE
  node scripts/notice.mjs runner/dist/auto-cache.mjs
} >runner/dist/NOTICE
cp LICENSE runner/dist/LICENSE

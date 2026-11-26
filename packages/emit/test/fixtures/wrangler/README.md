Output of `wrangler deploy --dry-run --outdir` (wrangler 4.161.0) for two small Workers, with the metadata its upload would carry.
`node-compat` keeps `node:buffer`, `node:crypto` and `node:events` as imports (wrangler leaves them to the platform).
`multi-module` is `no_bundle` with a text rule and a data rule; `lib/greet.js` is the relative import wrangler uploads beside it.

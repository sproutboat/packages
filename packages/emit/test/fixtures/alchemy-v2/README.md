A real Alchemy v2 Cloudflare bundle: the output of `@alchemy.run/cloudflare` `Workers/Source` for the spike app in
`spikes/alchemy-deploy-1125/app` (`src/Api.ts`: an Effect HTTP API with three SQLite Durable Objects and a WebSocket room),
copied from `.alchemy/bundles/AlchemyDemo-prod-Api` (alchemy 2.0.0-beta.87, Rolldown, minified, 2026-11-25).

`metadata.json` is what a Cloudflare script upload for it carries: the default flags Alchemy adds (`new_module_registry`), its
default date 2026-08-31, the Durable Object bindings and the `new_sqlite_classes` migration. The two large source maps are left out;
the small one stays to show a `sourcemap` module is accepted.

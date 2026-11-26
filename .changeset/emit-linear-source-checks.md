---
"@sproutboat/runtime": patch
---

`validateHttpSyncSource` and `neutraliseExports` read source in linear time. A long run of blank lines, or `import`, `from` or `require` followed by a long run of whitespace, made them quadratic (a 1 MiB upload took minutes). The patterns now match the same text; only the cost changes.

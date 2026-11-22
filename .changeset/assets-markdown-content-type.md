---
"@sproutboat/assets": patch
---

`.md` and `.markdown` files are served as `text/markdown; charset=utf-8`. They had no entry in the content-type table, so a static asset such as `README.md` was sent as `application/octet-stream`, which a browser downloads instead of showing.

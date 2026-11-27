---
"@sproutboat/runtime": patch
---

Embedded SQLite no longer needs a temporary file. A worker may create files only under its data directory, so a sort, temporary table or statement journal that outgrew the page cache failed with `unable to open database file` (SQLITE_CANTOPEN) when SQLite tried `/var/tmp` or `/tmp`. Every connection now sets `temp_store=MEMORY` (and statement journals stay in memory). Failures that remain name their file: a failed `open(2)` of the database, its `-wal`, `-shm` or a temporary file, and a statement that ends in CANTOPEN or an I/O error, write one rate-limited line to stderr (`sproutd-sqlite: app=ID open:rw+creat errno=13 (Permission denied) file=…`), without SQL text or row data.

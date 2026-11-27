import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A Landlocked worker (state dir only, empty environment) cannot open SQLite temp files in /tmp: sorts, temp tables and statement journals
// over the cache must run in memory, and what still fails must name its file, rate limited, with no SQL or rows. The ruleset is a copy
// of sproutd restrict_worker (it can drift; no seccomp). Linux only; no Landlock fails unless SB_TEST_ALLOW_NO_LANDLOCK=1; SB_TEST_TRANSPORT=FILE.
if (process.platform !== "linux") {
  console.log("native-sqlite-landlock: Linux only, skipped");
  process.exit(0);
}
const transport = await readFile(
  process.env.SB_TEST_TRANSPORT ?? new URL("../src/transport-embedded.js", import.meta.url),
  "utf8",
);
const ltxStart = transport.indexOf("// BEGIN LTX NATIVE"),
  ltxEnd = transport.indexOf("// END LTX NATIVE", ltxStart);
const tableStart = transport.indexOf("// BEGIN DB TABLE NATIVE"),
  tableEnd = transport.indexOf("// END DB TABLE NATIVE", tableStart);
assert(ltxStart > 0 && ltxEnd > ltxStart && tableStart > ltxEnd && tableEnd > tableStart);
const hasDiag = transport.includes("sb_diag_register");
const work = await mkdtemp(join(tmpdir(), "sb-native-landlock-"));
const source = `
#define _GNU_SOURCE
#include <sqlite3.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/landlock.h>
#include <time.h>
#include <errno.h>
// These four lines are transport-embedded.js's globals above the LTX block: keep them equal.
#define SB_MAX_DB 64
static sqlite3* sb_dbs[SB_MAX_DB];
static char sb_db_names[SB_MAX_DB][256];
static int sb_db_count = 0;
${transport.slice(ltxStart, ltxEnd)}
${transport.slice(tableStart, tableEnd)}

// The worker's ruleset in shape: every filesystem right handled, all of them (but execute) granted under DIR, read on /dev/urandom.
static int restrict_like_worker(const char* dir) {
  long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) { printf("{\\"landlock\\":%ld}\\n", abi); return -1; }
  struct landlock_ruleset_attr attr;
  memset(&attr, 0, sizeof attr);
  attr.handled_access_fs = (1ULL << 13) - 1;
  if (abi >= 2) attr.handled_access_fs |= 1ULL << 13;  // REFER
  if (abi >= 3) attr.handled_access_fs |= 1ULL << 14;  // TRUNCATE
  if (abi >= 5) attr.handled_access_fs |= 1ULL << 15;  // IOCTL_DEV
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, offsetof(struct landlock_ruleset_attr, handled_access_fs) + sizeof attr.handled_access_fs, 0);
  if (ruleset < 0) return -1;
  const char* paths[2] = { dir, "/dev/urandom" };
  for (int i = 0; i < 2; i++) {
    int fd = open(paths[i], O_PATH | O_CLOEXEC);
    if (fd < 0) return -1;
    struct landlock_path_beneath_attr rule;
    memset(&rule, 0, sizeof rule);
    rule.allowed_access = (i ? (1ULL << 2) : attr.handled_access_fs & ~1ULL) & attr.handled_access_fs;
    rule.parent_fd = fd;
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) return -1;
    close(fd);
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || syscall(SYS_landlock_restrict_self, ruleset, 0)) return -1;
  close(ruleset);
  return 0;
}
static char dbpath[600];
static int run(sqlite3* db, const char* q) {
  int rc = sqlite3_exec(db, q, 0, 0, 0);
  return rc;
}
// Steps a query to its end: the result code (0: done) and, in *rows, the rows seen.
static int drain(sqlite3* db, const char* q, long* rows) {
  sqlite3_stmt* st = 0;
  int rc = sqlite3_prepare_v2(db, q, -1, &st, 0);
  *rows = 0;
  if (rc) return sqlite3_extended_errcode(db);
  while ((rc = sqlite3_step(st)) == SQLITE_ROW) (*rows)++;
  sqlite3_finalize(st);
  return rc == SQLITE_DONE ? 0 : sqlite3_extended_errcode(db);
}
int main(int argc, char** argv) {
  const char* dir = argv[1];
  const char* scenario = argv[2];
  snprintf(dbpath, sizeof dbpath, "%s/d1/app.sqlite", dir);
  if (!strcmp(scenario, "seed")) {
    // 30,000 rows of 300 bytes, about 10 MiB: more than the 256 KiB page cache a worker's database starts with, by far.
    sb_sqlite_boot();
    int idx = sb_db_for(dbpath);
    if (idx < 0) { printf("{\\"error\\":\\"open\\"}\\n"); return 1; }
    sqlite3* db = sb_dbs[idx];
    if (run(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, k INTEGER UNIQUE, payload TEXT)") ||
        run(db, "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 30000) INSERT INTO t SELECT x, x, hex(randomblob(150)) || 'TOPSECRET-ROW-DATA' FROM c")) {
      printf("{\\"error\\":\\"seed: %s\\"}\\n", sqlite3_errmsg(db)); return 1;
    }
    printf("{\\"ok\\":1}\\n");
    return 0;
  }
  if (restrict_like_worker(dir)) { printf("{\\"error\\":\\"no landlock\\"}\\n"); return 3; }
  sb_sqlite_boot();
  // A path the ruleset closes, and does not let SQLite create a file in: the first open of a worker's database fails the same way.
  if (!strcmp(scenario, "open-outside")) {
    char outside[128];
    snprintf(outside, sizeof outside, "/tmp/sb-landlock-outside-%d.sqlite", (int)getpid());
    int idx = sb_db_for(outside);
    printf("{\\"idx\\":%d}\\n", idx);
    return 0;
  }
  if (!strcmp(scenario, "open-burst")) {
    // 50 failing opens in a row, then (after the window) one more
    for (int i = 0; i < 50; i++) { char outside[128]; snprintf(outside, sizeof outside, "/tmp/sb-landlock-burst-%d-%d.sqlite", (int)getpid(), i); sb_db_for(outside); }
    struct timespec nap = { 0, 400 * 1000 * 1000 };
    nanosleep(&nap, 0);
    sb_db_for("/tmp/sb-landlock-after.sqlite");
    printf("{\\"ok\\":1}\\n");
    return 0;
  }
  int idx = sb_db_for(dbpath);
  if (idx < 0) { printf("{\\"error\\":\\"open the database\\"}\\n"); return 1; }
  sqlite3* db = sb_dbs[idx];
  long rows = 0;
  if (!strcmp(scenario, "sort")) {
    // no index on payload: the sorter holds about 10 MiB against a 256 KiB cache
    int rc = drain(db, "SELECT payload FROM t ORDER BY payload", &rows);
    printf("{\\"rc\\":%d,\\"rows\\":%ld}\\n", rc, rows);
    return 0;
  }
  if (!strcmp(scenario, "temptable")) {
    int rc = run(db, "CREATE TEMP TABLE tt AS SELECT * FROM t");
    printf("{\\"rc\\":%d,\\"extended\\":%d}\\n", rc ? sqlite3_extended_errcode(db) : 0, sqlite3_extended_errcode(db));
    return 0;
  }
  if (!strcmp(scenario, "stmtjrnl")) {
    // inside a transaction (D1 batches are one, with a savepoint), every row changes under a UNIQUE index: the statement may abort,
    // so SQLite keeps a statement journal of the 10 MiB it rewrites
    int rc = run(db, "BEGIN") || run(db, "UPDATE t SET k = k + 100000");
    int ext = rc ? sqlite3_extended_errcode(db) : 0;
    run(db, "ROLLBACK");
    printf("{\\"rc\\":%d}\\n", ext);
    return 0;
  }
  if (!strcmp(scenario, "tempfile")) {
    // the old behaviour on purpose, with a statement that names row data and a literal: the failure must be reported without either
    run(db, "PRAGMA temp_store=FILE");
    int rc = drain(db, "SELECT payload, 'TOPSECRET-SQL-LITERAL' FROM t ORDER BY payload", &rows);
    ${hasDiag ? "if (rc) sb_diag_failure(db, rc);" : ""}
    printf("{\\"rc\\":%d}\\n", rc);
    return 0;
  }
  return 2;
}
`;
await Bun.write(join(work, "driver.c"), source);
const binary = join(work, "driver");
const amalgamation = process.env.SB_TEST_SQLITE_DIR;
const flags = ["-DSB_DIAG_WINDOW_MS=300"];
const compile = Bun.spawnSync(
  amalgamation
    ? [
        "cc",
        "-O2",
        ...flags,
        `-I${amalgamation}`,
        join(work, "driver.c"),
        join(amalgamation, "sqlite3.o"),
        "-lm",
        "-ldl",
        "-lpthread",
        "-o",
        binary,
      ]
    : ["cc", "-O1", ...flags, join(work, "driver.c"), "-lsqlite3", "-o", binary],
);
assert.equal(compile.exitCode, 0, compile.stderr.toString());

// A worker has an empty environment but for what the host sets: no TMPDIR, no SQLITE_TMPDIR.
async function run(scenario: string, dir: string) {
  const p = Bun.spawnSync([binary, dir, scenario], { env: { PATH: process.env.PATH ?? "", SB_DATA_DIR: dir } });
  const stdout = p.stdout.toString().trim();
  const stderr = p.stderr.toString();
  assert.equal(p.exitCode, 0, `${scenario}: exit ${p.exitCode} ${stdout} ${stderr}`);
  return { out: JSON.parse(stdout.split("\n").pop()!), stderr };
}
const lines = (stderr: string) => stderr.split("\n").filter((l) => l.startsWith("sproutd-sqlite:"));
try {
  const dir = join(work, "myapp");
  await run("seed", dir);
  const landlock = Bun.spawnSync([binary, dir, "open-outside"], {
    env: { PATH: process.env.PATH ?? "", SB_DATA_DIR: dir },
  });
  if (landlock.stdout.toString().includes('"landlock"') || landlock.stdout.toString().includes("no landlock")) {
    assert(
      process.env.SB_TEST_ALLOW_NO_LANDLOCK === "1",
      `this kernel has no Landlock (${landlock.stdout}); set SB_TEST_ALLOW_NO_LANDLOCK=1 to allow`,
    );
    console.log("native-sqlite-landlock: no Landlock on this kernel, skipped");
    process.exit(0);
  }

  // The statements that used to spill a temporary file (CANTOPEN, 14) must succeed; every one is reported, not just the first.
  const spills = {
    sort: await run("sort", dir),
    temptable: await run("temptable", dir),
    stmtjrnl: await run("stmtjrnl", dir),
  };
  const failed = Object.entries(spills)
    .filter(([name, r]) => r.out.rc !== 0 || (name === "sort" && r.out.rows !== 30000))
    .map(([name, r]) => `${name}: ${JSON.stringify(r.out)}`);
  assert.deepEqual(failed, [], "a temporary file was needed under Landlock (rc 14 is SQLITE_CANTOPEN)");
  for (const r of Object.values(spills)) assert.deepEqual(lines(r.stderr), [], "no diagnostic line when nothing fails");

  if (hasDiag) {
    // A temporary file the ruleset refuses (temp_store=FILE again), through a statement with a literal and row data: the open, the
    // log and the statement are reported by what failed, and neither the SQL nor a row is in any line. The database is shown
    // relative to the data directory.
    const spill = await run("tempfile", dir);
    assert.equal(spill.out.rc & 0xff, 14, `${JSON.stringify(spill.out)} ${spill.stderr}`);
    const all = lines(spill.stderr);
    assert(
      all.some((l) =>
        /^sproutd-sqlite: app=myapp open:rw\+creat errno=13 \(Permission denied\) file=\/(var\/tmp|usr\/tmp|tmp)\/etilqs_\w+$/.test(
          l,
        ),
      ),
      spill.stderr,
    );
    assert(
      all.some((l) =>
        /^sproutd-sqlite: app=myapp stmt rc=14 errno=\d+ \([^)]+\) file=\$DATA\/d1\/app\.sqlite$/.test(l),
      ),
      spill.stderr,
    );
    assert(!spill.stderr.includes("TOPSECRET"), `no SQL text or row data on stderr: ${spill.stderr}`);
    assert(!spill.stderr.includes(dir), `no host path on stderr: ${spill.stderr}`);
    assert(!spill.stderr.includes("statement aborts"), spill.stderr);

    // The first open fails, and SQLite retries it read-only: a line for each call with its own errno (EACCES, then ENOENT)
    const outside = await run("open-outside", dir);
    assert.equal(outside.out.idx, -1);
    const open = lines(outside.stderr);
    assert.equal(open.length, 2, outside.stderr);
    assert.match(
      open[0],
      /^sproutd-sqlite: app=myapp open:rw\+creat errno=13 \(Permission denied\) file=\/tmp\/sb-landlock-outside-\d+\.sqlite$/,
    );
    assert.match(
      open[1],
      /^sproutd-sqlite: app=myapp open:ro errno=2 \(No such file or directory\) file=\/tmp\/sb-landlock-outside-\d+\.sqlite$/,
    );

    // 50 failing opens (two calls each) in a burst: SB_DIAG_BURST lines, then the count with the next line after the window
    const burst = await run("open-burst", dir);
    const b = lines(burst.stderr);
    assert.equal(b.length, 7, burst.stderr);
    assert(b[5].endsWith(" suppressed=95"), b[5]);
    assert(
      b.slice(0, 5).every((l) => !l.includes("suppressed")),
      burst.stderr,
    );
  }
  console.log("native-sqlite-landlock ok", hasDiag ? "(diagnostics checked)" : "(no diagnostics in this transport)");
} finally {
  await rm(work, { recursive: true, force: true });
}

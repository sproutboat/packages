import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
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
const hasHeap = transport.includes("sqlite3_hard_heap_limit64(");
// The real call sites of the statement diagnostics (sb_sql_script, sb_sql_error), compiled from the transport itself.
const replyStart = transport.indexOf("// BEGIN SQL REPLY NATIVE"),
  replyEnd = transport.indexOf("// END SQL REPLY NATIVE", replyStart);
const scriptStart = transport.indexOf("// BEGIN SQL SCRIPT NATIVE"),
  scriptEnd = transport.indexOf("// END SQL SCRIPT NATIVE", scriptStart);
const hasScript = replyStart > 0 && replyEnd > replyStart && scriptStart > replyEnd && scriptEnd > scriptStart;
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
${hasScript ? "#define SB_SQLITE_ROW 100\n#define SB_SQLITE_DONE 101\n" + transport.slice(replyStart, replyEnd) + transport.slice(scriptStart, scriptEnd) : ""}

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
  if (!strcmp(scenario, "sort-survive")) {
    // under a small memory limit the big sort is refused (SQLITE_NOMEM), and the worker goes on: the same connection answers
    // a small query, a top-N sort and a count, and a second big sort fails the same way
    int big = drain(db, "SELECT payload FROM t ORDER BY payload", &rows);
    long after = 0, topn = 0, count = 0;
    int small = drain(db, "SELECT k FROM t WHERE k < 100", &after);
    int top = drain(db, "SELECT payload FROM t ORDER BY payload LIMIT 10", &topn);
    int again = drain(db, "SELECT payload FROM t ORDER BY payload", &count);
    int tt = run(db, "CREATE TEMP TABLE tt AS SELECT * FROM t") ? sqlite3_extended_errcode(db) : 0;
    long left = 0;
    int ok = drain(db, "SELECT k FROM t WHERE k < 100", &left);
    printf("{\\"big\\":%d,\\"small\\":%d,\\"smallRows\\":%ld,\\"top\\":%d,\\"topRows\\":%ld,\\"again\\":%d,\\"temptable\\":%d,\\"after\\":%d,\\"afterRows\\":%ld}\\n", big, small, after, top, topn, again, tt, ok, left);
    return 0;
  }
  if (!strcmp(scenario, "stmtjrnl-file")) {
    // a tenant's own PRAGMA temp_store=FILE: the statement journal still stays in memory (the sort would not, see "tempfile")
    run(db, "PRAGMA temp_store=FILE");
    int rc = run(db, "BEGIN") || run(db, "UPDATE t SET k = k + 100000");
    int ext = rc ? sqlite3_extended_errcode(db) : 0;
    run(db, "ROLLBACK");
    printf("{\\"rc\\":%d}\\n", ext);
    return 0;
  }
  if (!strcmp(scenario, "wal-fail")) {
    // The first pragmas of a new connection fail (journal_mode=WAL: its -wal is a directory), through sb_db_for's own check
    char wal[700], other[700];
    snprintf(other, sizeof other, "%s/d1/w.sqlite", dir);
    snprintf(wal, sizeof wal, "%s-wal", other);
    mkdir(wal, 0700);
    int w = sb_db_for(other);
    printf("{\\"idx\\":%d}\\n", w);
    return 0;
  }
  if (!strcmp(scenario, "logline")) {
    // SQLite's own log, through the callback sb_sqlite_boot installed: the path of a failed call is shown as the others are
    sqlite3_log(SQLITE_IOERR_WRITE, "os_unix.c:%d: (%d) %s(%s) - %s", 4242, 13, "write", dbpath, "Permission denied");
    sqlite3_log(SQLITE_IOERR_READ, "os_unix.c:%d: (%d) %s(%s) - %s", 4243, 5, "read", "/home/someone/secret-layout/other.sqlite-wal", "Input/output error");
    sqlite3_log(SQLITE_CANTOPEN, "statement aborts at %d: [%s] %s", 3, "SELECT 'TOPSECRET-SQL-LITERAL'", "unable to open database file");
    sqlite3_log(SQLITE_CANTOPEN, "cannot open file at line %d of [%s]", 99, "0123456789abcdef");
    printf("{\\"ok\\":1}\\n");
    return 0;
  }
${
  hasScript
    ? `  if (!strcmp(scenario, "script")) {
    // through sb_sql_script (the host's exec call): a statement that needs a temporary file the ruleset refuses
    run(db, "PRAGMA temp_store=FILE");
    char* reply = sb_sql_script(dbpath, "SELECT payload, 'TOPSECRET-SQL-LITERAL' FROM t ORDER BY payload");
    printf("{\\"reply\\":%s}\\n", reply);
    return 0;
  }
  if (!strcmp(scenario, "error")) {
    // through sb_sql_error (every other call): the statement fails at step, then the reply is built, and LTX's own failure is no I/O error
    run(db, "PRAGMA temp_store=FILE");
    sqlite3_stmt* st = 0;
    sqlite3_prepare_v2(db, "SELECT payload, 'TOPSECRET-SQL-LITERAL' FROM t ORDER BY payload", -1, &st, 0);
    while (sqlite3_step(st) == SQLITE_ROW) {}
    char* reply = sb_sql_error(db, 0, -1, 0);
    sqlite3_finalize(st);
    printf("{\\"reply\\":%s}\\n", reply);
    return 0;
  }
  if (!strcmp(scenario, "error-ltx")) {
    // an error that is the replication's own is not reported as SQLite's last errno, even with an I/O error on the connection
    run(db, "PRAGMA temp_store=FILE");
    drain(db, "SELECT payload FROM t ORDER BY payload", &rows);
    char* reply = sb_sql_error(db, SB_LTX_FAILED, 10, 0);
    printf("{\\"reply\\":%s}\\n", reply);
    return 0;
  }
`
    : ""
}  if (!strcmp(scenario, "tempfile")) {
    // the old behaviour on purpose, with a statement that names row data and a literal: the failure must be reported without either
    run(db, "PRAGMA temp_store=FILE");
    int rc = drain(db, "SELECT payload, 'TOPSECRET-SQL-LITERAL' FROM t ORDER BY payload", &rows);
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
// dataDir is what the host puts in SB_DATA_DIR (it may spell dir differently); extra adds environment (the memory limit).
async function run(scenario: string, dir: string, dataDir = dir, extra: Record<string, string> = {}) {
  const p = Bun.spawnSync([binary, dir, scenario], {
    env: { PATH: process.env.PATH ?? "", SB_DATA_DIR: dataDir, ...extra },
  });
  const stdout = p.stdout.toString().trim();
  const stderr = p.stderr.toString();
  assert.equal(p.exitCode, 0, `${scenario}: exit ${p.exitCode} ${stdout} ${stderr}`);
  return { out: JSON.parse(stdout.split("\n").pop()!), stderr };
}
const lines = (stderr: string) => stderr.split("\n").filter((l) => l.startsWith("sproutd-sqlite:"));
try {
  // The state root is reached through a symlink (state -> state-real), as a host whose state directory moved disks would have it.
  const dir = join(work, "state-real", "myapp");
  await mkdir(join(work, "state-real"), { recursive: true });
  await symlink(join(work, "state-real"), join(work, "state"));
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

  // No host path on any line: not the real state root, not its symlink, not the work directory around them.
  const noHostPath = (stderr: string) => {
    for (const bad of [work, "state-real", "/state/"])
      assert(!stderr.includes(bad), `host path ${bad} on stderr: ${stderr}`);
    assert(!stderr.includes("TOPSECRET"), `no SQL text or row data on stderr: ${stderr}`);
    assert(!stderr.includes("statement aborts"), stderr);
  };

  if (hasHeap) {
    // A hard heap limit of a quarter of the memory limit (8 MiB at 32 MiB): the 10 MiB sort and the temporary table are refused with
    // SQLITE_NOMEM (7) and the same connection, and the process, go on. Without a limit (the runs above) 256 MiB: they succeed.
    const small = await run("sort-survive", dir, dir, {
      SB_MEMORY_LIMIT: String(32 << 20),
    });
    assert.deepEqual(
      small.out,
      {
        big: 7,
        small: 0,
        smallRows: 99,
        top: 0,
        topRows: 10,
        again: 7,
        temptable: 7,
        after: 0,
        afterRows: 99,
      },
      JSON.stringify(small.out),
    );
    assert.deepEqual(lines(small.stderr), [], "no diagnostic line for an out-of-memory statement");
    // 64 MiB of limit is 16 MiB of heap: the 10 MiB sort fits
    const roomy = await run("sort", dir, dir, {
      SB_MEMORY_LIMIT: String(64 << 20),
    });
    assert.deepEqual(roomy.out, { rc: 0, rows: 30000 });
  }
  // a statement journal needs no file even when a tenant sets temp_store=FILE
  assert.equal((await run("stmtjrnl-file", dir)).out.rc, 0);

  if (hasDiag) {
    // A temporary file the ruleset refuses (temp_store=FILE again), through a statement with a literal and row data: the open and
    // the log are reported by what failed, and neither the SQL nor a row is in any line. A path outside the data directory is shown
    // as its basename only.
    const spill = await run("tempfile", dir);
    assert.equal(spill.out.rc & 0xff, 14, `${JSON.stringify(spill.out)} ${spill.stderr}`);
    assert(
      lines(spill.stderr).some((l) =>
        /^sproutd-sqlite: app=myapp open:rw\+creat errno=13 \(Permission denied\) file=<outside>\/etilqs_\w+$/.test(l),
      ),
      spill.stderr,
    );
    noHostPath(spill.stderr);
    assert(!/file=\/(var\/tmp|usr\/tmp|tmp)\//.test(spill.stderr), spill.stderr);

    // The first open fails, and SQLite retries it read-only: a line for each call with its own errno (EACCES, then ENOENT)
    const outside = await run("open-outside", dir);
    assert.equal(outside.out.idx, -1);
    const open = lines(outside.stderr);
    assert.equal(open.length, 2, outside.stderr);
    assert.match(
      open[0],
      /^sproutd-sqlite: app=myapp open:rw\+creat errno=13 \(Permission denied\) file=<outside>\/sb-landlock-outside-\d+\.sqlite$/,
    );
    assert.match(
      open[1],
      /^sproutd-sqlite: app=myapp open:ro errno=2 \(No such file or directory\) file=<outside>\/sb-landlock-outside-\d+\.sqlite$/,
    );
    assert(!outside.stderr.includes("/tmp"), outside.stderr);

    // 50 failing opens (two calls each) in a burst: SB_DIAG_BURST lines, then the count with the next line after the window
    const burst = await run("open-burst", dir);
    const b = lines(burst.stderr);
    assert.equal(b.length, 7, burst.stderr);
    assert(b[5].endsWith(" suppressed=95"), b[5]);
    assert(
      b.slice(0, 5).every((l) => !l.includes("suppressed")),
      burst.stderr,
    );

    // SQLite's own log for a failed call: the path is shown as $DATA/... or its basename; the statement text never appears; and
    // no errno is invented (-)
    const log = lines((await run("logline", dir)).stderr);
    assert.deepEqual(log, [
      "sproutd-sqlite: app=myapp log rc=778 errno=- file=os_unix.c:4242: (13) write($DATA/d1/app.sqlite) - Permission denied",
      "sproutd-sqlite: app=myapp log rc=266 errno=- file=os_unix.c:4243: (5) read(<outside>/other.sqlite-wal) - Input/output error",
    ]);

    // A failing journal_mode=WAL when a connection opens (the check in sb_db_for): its -wal is a directory
    const wal = await run("wal-fail", dir);
    const w = lines(wal.stderr);
    assert(
      w.some((l) =>
        /^sproutd-sqlite: app=myapp stmt rc=\d+ errno=21 \(Is a directory\) file=\$DATA\/d1\/w\.sqlite$/.test(l),
      ),
      wal.stderr,
    );
    assert(
      w.some((l) =>
        /^sproutd-sqlite: app=myapp log rc=\d+ errno=- file=os_unix\.c:\d+: \(21\) unlink\(\$DATA\/d1\/w\.sqlite-wal\) - $/.test(
          l,
        ),
      ),
      wal.stderr,
    );
    noHostPath(wal.stderr);

    if (hasScript) {
      // The statement line through the real call sites, and the data directory spelled three ways (as configured, through the
      // symlink, and unnormalised): SQLite names the file by its real path every time, and the line must still say $DATA.
      const spellings = [dir, join(work, "state", "myapp"), join(work, "state") + "//./myapp/"];
      for (const dataDir of spellings) {
        for (const scenario of ["script", "error"]) {
          const r = await run(scenario, dir, dataDir);
          assert.equal(r.out.reply.ok, false, `${scenario} ${dataDir}: ${JSON.stringify(r.out)}`);
          assert.equal(r.out.reply.code & 0xff, 14, JSON.stringify(r.out));
          assert(
            lines(r.stderr).some((l) =>
              /^sproutd-sqlite: app=myapp stmt rc=14 errno=\d+ \([^)]+\) file=\$DATA\/d1\/app\.sqlite$/.test(l),
            ),
            `${scenario} ${dataDir}: ${r.stderr}`,
          );
          noHostPath(r.stderr);
          assert(!JSON.stringify(r.out).includes("TOPSECRET"), JSON.stringify(r.out));
        }
        // the data directory's own name is the app (the link is not)
        const open = await run("open-outside", dir, dataDir);
        noHostPath(open.stderr);
      }
      // the replication's own failure is not SQLite's last errno: the io error on the connection stays out of its reply
      const ltx = await run("error-ltx", dir);
      assert.equal(ltx.out.reply.code, 10);
      assert(!lines(ltx.stderr).some((l) => l.includes(" stmt ")), ltx.stderr);
    }
  }
  console.log("native-sqlite-landlock ok", hasDiag ? "(diagnostics checked)" : "(no diagnostics in this transport)");
} finally {
  await rm(work, { recursive: true, force: true });
}

// 예약 작업 목록(scheduled-tasks.json) 합치기 시험. 가짜 앱 데이터 폴더와 main.log를 만들어 --once로 돌린다.
// 실제 앱 데이터·상태 폴더는 건드리지 않는다(LOCALAPPDATA·APPDATA·USERPROFILE·CLAUDE_SESSION_SHARE_HOME을 시험 폴더로).
// 실행: node --test test/registry.test.mjs   (PowerShell에서. 스토어 앱 안 터미널에서는 AppData가 돌려질 수 있다)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// CLAUDE_SESSION_SHARE_SCRIPT로 다른 판(예: 고치기 전 판)을 시험할 수 있다.
const SCRIPT = process.env.CLAUDE_SESSION_SHARE_SCRIPT || path.join(HERE, "..", "claude-session-share.mjs");
const ORG = "0000000a-0000-4000-8000-00000000000f";
const ACCT = { A: "aaaaaaaa-0000-4000-8000-000000000001", B: "bbbbbbbb-0000-4000-8000-000000000002", C: "cccccccc-0000-4000-8000-000000000003", D: "dddddddd-0000-4000-8000-000000000004" };
const T0 = Math.floor(Date.now() / 1000) - 100000;

function setup(name) {
  const root = path.join(HERE, "..", ".test-tmp", name);
  fs.rmSync(root, { recursive: true, force: true });
  const env = {
    ...process.env,
    USERPROFILE: path.join(root, "home"), HOME: path.join(root, "home"),
    LOCALAPPDATA: path.join(root, "local"), APPDATA: path.join(root, "roaming"),
    CLAUDE_SESSION_SHARE_HOME: path.join(root, "share"),
  };
  for (const d of [env.USERPROFILE, path.join(env.LOCALAPPDATA, "Claude", "logs")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(env.LOCALAPPDATA, "Claude", "logs", "main.log"), "");
  const tree = path.join(env.APPDATA, "Claude", "claude-code-sessions");
  const dir = (who) => path.join(tree, ACCT[who], ORG);
  let clock = T0;
  const t = {
    root, env, dir,
    make(who) { fs.mkdirSync(dir(who), { recursive: true }); },
    write(who, tasks, extra = {}) {
      t.make(who);
      const p = path.join(dir(who), "scheduled-tasks.json");
      fs.writeFileSync(p, JSON.stringify({ scheduledTasks: tasks, recordedSkips: {}, sundayAliasBoundaryStamped: true, dayFieldsOrBoundaryStamped: true, ...extra }, null, 2));
      clock += 10;
      fs.utimesSync(p, clock, clock); // 같은 틱 쓰기의 mtime이 겹치지 않게 시각을 정해 준다
    },
    read(who) { return JSON.parse(fs.readFileSync(path.join(dir(who), "scheduled-tasks.json"), "utf8")); },
    ids(who) { return t.read(who).scheduledTasks.map((x) => x.id); },
    login(who) {
      fs.appendFileSync(path.join(env.LOCALAPPDATA, "Claude", "logs", "main.log"),
        `2026-10-18 00:00:00 [info] [LocalSessionManager] Initialization succeeded — accountId=${ACCT[who]}, orgId=${ORG}, existingSessions=0\n`);
    },
    run() {
      const r = spawnSync(process.execPath, [SCRIPT, "--once"], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      return r.stdout;
    },
    log() { try { return fs.readFileSync(path.join(env.CLAUDE_SESSION_SHARE_HOME, "claude-session-share.log"), "utf8"); } catch { return ""; } },
  };
  return t;
}
const task = (id, extra = {}) => ({ id, displayName: id, cronExpression: "0 9 * * *", enabled: true, filePath: `C:\\tasks\\${id}\\SKILL.md`, createdAt: 1, ...extra });

test("폴더마다 다른 작업을 합치고, 목록이 없는 폴더도 채우고, recordedSkips도 합친다", () => {
  const t = setup("merge");
  t.write("A", [task("x")], { recordedSkips: { "x@1": 1 } });
  t.write("B", [task("y")], { recordedSkips: { "y@1": 2 } });
  t.make("C");
  t.run();
  for (const who of ["A", "B", "C"]) {
    assert.deepEqual(t.ids(who), ["x", "y"], who);
    assert.deepEqual(t.read(who).recordedSkips, { "x@1": 1, "y@1": 2 }, who);
    assert.equal(t.read(who).sundayAliasBoundaryStamped, true);
  }
  t.run(); // 두 번째는 바꿀 게 없다
  assert.deepEqual(t.ids("C"), ["x", "y"]);
});

test("처음 로그인한 짝의 빈 목록이 다른 계정의 예약을 지우지 않는다", () => {
  const t = setup("fresh");
  t.write("A", [task("x"), task("y")]);
  t.write("B", [task("x"), task("y")]);
  t.run();
  t.login("D");                // 처음 보는 짝으로 로그인
  t.write("D", []);            // 앱이 새 빈 목록을 가장 최근 파일로 쓴다
  t.run();
  for (const who of ["A", "B", "D"]) assert.deepEqual(t.ids(who), ["x", "y"], who);
  assert.doesNotMatch(t.log(), /-x|-y/);
});

test("앱이 모르는 작업(미러가 넣어 준 것)이 빠지면 지우지 않고, 앱이 새로 만든 작업은 퍼진다", () => {
  const t = setup("unknown");
  t.write("A", [task("x"), task("y")]);
  t.run();
  t.login("D");
  t.write("D", []);
  t.run();                     // D에 x, y를 채웠지만 D의 앱은 둘을 모른다
  t.write("D", [task("z")]);   // D의 앱이 z를 만들며 메모리 목록(빈 것 + z)을 쓴다
  t.run();
  for (const who of ["A", "D"]) assert.deepEqual(t.ids(who), ["x", "y", "z"], who);
  assert.match(t.log(), /되살림\(앱이 모르는 작업\)/);
});

test("앱이 아는 작업 하나를 지우면 모든 계정에서 지운다", () => {
  const t = setup("delete");
  t.write("A", [task("x"), task("y")]);
  t.write("B", [task("x"), task("y")]);
  t.run();
  t.login("A");                // A의 앱이 x, y를 읽었다
  t.run();
  t.write("A", [task("x")]);   // 사용자가 A에서 y를 지움
  t.run();
  for (const who of ["A", "B"]) assert.deepEqual(t.ids(who), ["x"], who);
  assert.match(t.log(), /예약 작업 -y/);
});

test("한 번에 둘 이상 빠지면 지우지 않고 되살린다", () => {
  const t = setup("bulk");
  t.write("A", [task("x"), task("y")]);
  t.write("B", [task("x"), task("y")]);
  t.run();
  t.login("A");
  t.run();
  t.write("A", []);            // 아는 작업 둘이 한꺼번에 빠짐(옛 메모리 목록 쓰기 같은 것)
  t.run();
  for (const who of ["A", "B"]) assert.deepEqual(t.ids(who), ["x", "y"], who);
  assert.match(t.log(), /한 번에 2개가 빠짐/);
});

test("마지막 남은 작업 하나도 지울 수 있다", () => {
  const t = setup("last");
  t.write("A", [task("x")]);
  t.write("B", [task("x")]);
  t.run();
  t.login("A");
  t.run();
  t.write("A", []);
  t.run();
  for (const who of ["A", "B"]) assert.deepEqual(t.ids(who), [], who);
});

test("더 최근에 고친 작업 내용이 모든 계정에 퍼진다", () => {
  const t = setup("update");
  t.write("A", [task("x")]);
  t.write("B", [task("x")]);
  t.run();
  t.write("B", [task("x", { enabled: false, cronExpression: "0 21 * * *" })]);
  t.run();
  for (const who of ["A", "B"]) {
    assert.equal(t.read(who).scheduledTasks[0].enabled, false, who);
    assert.equal(t.read(who).scheduledTasks[0].cronExpression, "0 21 * * *", who);
  }
});

test("옛 상태에 목록 파일 줄이 남아 있어도 목록 파일을 지우지 않고, 다른 파일 미러는 그대로 한다", () => {
  const t = setup("legacy");
  t.write("A", [task("x")]);
  t.write("B", [task("x")]);
  fs.mkdirSync(t.env.CLAUDE_SESSION_SHARE_HOME, { recursive: true });
  // 고치기 전 판이 남긴 상태: 목록 파일이 공통 파일 목록에 있고 두 폴더가 맞춰진 것으로 적혀 있다.
  fs.writeFileSync(path.join(t.env.CLAUDE_SESSION_SHARE_HOME, "claude-session-share.json"), JSON.stringify({
    v: 2, known: {}, union: { "claude-code-sessions": { "scheduled-tasks.json": { m: 1, s: 1 } } },
    synced: { "claude-code-sessions": [t.dir("A"), t.dir("B")] },
  }));
  fs.writeFileSync(path.join(t.dir("A"), "local_1.json"), JSON.stringify({ cliSessionId: "c1" }));
  t.run();
  for (const who of ["A", "B"]) assert.deepEqual(t.ids(who), ["x"], who);
  assert.ok(fs.existsSync(path.join(t.dir("B"), "local_1.json")), "세션 기록은 그대로 복사된다");
  const state = JSON.parse(fs.readFileSync(path.join(t.env.CLAUDE_SESSION_SHARE_HOME, "claude-session-share.json"), "utf8"));
  assert.equal(state.union["claude-code-sessions"]["scheduled-tasks.json"], undefined);
});

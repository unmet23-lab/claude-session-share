// 세션 기록 미러 시험. 가짜 앱 데이터 폴더를 만들어 --once·--status로 돌린다.
// 실제 앱 데이터·상태 폴더는 건드리지 않는다(LOCALAPPDATA·APPDATA·USERPROFILE·CLAUDE_SESSION_SHARE_HOME을 시험 폴더로).
// 실행: 저장소 폴더에서 node --test   (PowerShell에서. 스토어 앱 안 터미널에서는 AppData가 돌려질 수 있다)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.CLAUDE_SESSION_SHARE_SCRIPT || path.join(HERE, "..", "claude-session-share.mjs");
const ORG = "0000000a-0000-4000-8000-00000000000f";
const ACCT = { A: "aaaaaaaa-0000-4000-8000-000000000001", B: "bbbbbbbb-0000-4000-8000-000000000002" };
const CLI = "99999999-9999-4999-8999-999999999999";

function setup(name) {
  const root = path.join(HERE, "..", ".test-tmp", `mirror-${name}`);
  fs.rmSync(root, { recursive: true, force: true });
  const env = {
    ...process.env,
    USERPROFILE: path.join(root, "home"), HOME: path.join(root, "home"),
    LOCALAPPDATA: path.join(root, "local"), APPDATA: path.join(root, "roaming"),
    CLAUDE_SESSION_SHARE_HOME: path.join(root, "share"),
    CLAUDE_SESSION_SHARE_NOTIFY_FILE: path.join(root, "notify.txt"), // 진짜 윈도 알림을 띄우지 않는다
  };
  delete env.CLAUDE_CONFIG_DIR;
  for (const d of [env.USERPROFILE, path.join(env.LOCALAPPDATA, "Claude", "logs")]) fs.mkdirSync(d, { recursive: true });
  const mainLog = path.join(env.LOCALAPPDATA, "Claude", "logs", "main.log");
  fs.writeFileSync(mainLog, "");
  const tree = path.join(env.APPDATA, "Claude", "claude-code-sessions");
  const dir = (who) => path.join(tree, ACCT[who], ORG);
  for (const who of Object.keys(ACCT)) fs.mkdirSync(dir(who), { recursive: true });
  const t = {
    dir,
    put(who, name, body, ageSec = 1000) {
      const p = path.join(dir(who), name);
      fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
      const when = Date.now() / 1000 - ageSec;
      fs.utimesSync(p, when, when);
    },
    has: (who, name) => fs.existsSync(path.join(dir(who), name)),
    log: (text) => fs.appendFileSync(mainLog, text),
    notes: () => (fs.existsSync(env.CLAUDE_SESSION_SHARE_NOTIFY_FILE) ? fs.readFileSync(env.CLAUDE_SESSION_SHARE_NOTIFY_FILE, "utf8") : ""),
    run(mode = "--once") {
      const r = spawnSync(process.execPath, [SCRIPT, mode], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      return r.stdout;
    },
  };
  return t;
}

test("한 폴더에만 있는 세션 기록이 모든 계정 폴더로 퍼지고, 앱 임시 파일(*.json.tmp)은 옮기지 않는다", () => {
  const t = setup("spread");
  t.put("A", "local_s1.json", { sessionId: "local_s1", cliSessionId: "11111111-1111-4111-8111-111111111111", title: "첫 세션" });
  t.put("A", "local_s2.json.tmp", { sessionId: "local_s2" }, 1);
  t.run();
  assert.ok(t.has("B", "local_s1.json"), "세션 기록이 B로 퍼져야 한다");
  assert.ok(!t.has("B", "local_s2.json.tmp"), "앱 임시 파일은 옮기지 않아야 한다");
  assert.equal(fs.readFileSync(path.join(t.dir("B"), "local_s1.json"), "utf8"), fs.readFileSync(path.join(t.dir("A"), "local_s1.json"), "utf8"));
});

test("앱이 지운 세션(deleted_ 표식)은 다른 폴더에 옛 사본이 있어도 되살리지 않는다", () => {
  const t = setup("tomb");
  t.put("A", `deleted_${CLI}`, "1760000000000");
  t.put("B", "local_old.json", { sessionId: "local_old", cliSessionId: CLI, title: "지운 세션의 옛 사본" });
  t.run();
  assert.ok(!t.has("A", "local_old.json"), "지운 세션을 A로 되살리면 안 된다");
  assert.ok(!t.has("B", "local_old.json"), "옛 사본도 지워야 한다");
  assert.ok(t.has("B", `deleted_${CLI}`), "삭제 표식은 모든 폴더로 퍼진다");
});

test("맞춘 뒤 한 폴더에서 지운 기록은 다른 폴더에서도 지운다", () => {
  const t = setup("delete");
  t.put("A", "local_s3.json", { sessionId: "local_s3", cliSessionId: "33333333-3333-4333-8333-333333333333" });
  t.run();
  assert.ok(t.has("B", "local_s3.json"));
  fs.unlinkSync(path.join(t.dir("A"), "local_s3.json"));
  t.run();
  assert.ok(!t.has("B", "local_s3.json"), "A에서 지운 기록은 B에서도 지워야 한다");
});

test("--status는 맞춰졌으면 판정 한 줄(○ N곳이 모두 같습니다)을 보인다", () => {
  const t = setup("status");
  t.put("A", "local_s4.json", { sessionId: "local_s4", cliSessionId: "44444444-4444-4444-8444-444444444444" });
  t.run();
  const out = t.run("--status");
  assert.match(out, /○ 2곳이 모두 같습니다\(세션 1개\)/);
  assert.match(out, /Code 탭 세션\(claude-code-sessions\)/);
});

// 앱 기록(main.log) 줄. existing을 빼면 existingSessions가 없는 옛 앱 판의 줄이다.
const initLine = (acct, existing) =>
  `2026-10-19 08:50:58 [info] [LocalSessionManager] Initialization succeeded — accountId=${acct}, orgId=${ORG}${existing === undefined ? "" : `, existingSessions=${existing}`}\n`;
const loadedLine = (acct, n, home = "C:\\Users\\me") =>
  `2026-10-19 08:50:58 [info] Loaded ${n} persisted sessions from ${home}\\AppData\\Roaming\\Claude\\claude-code-sessions\\${acct}\\${ORG} (0 archived deferred)\n`;
const noteLines = (t) => t.notes().split("\n").filter(Boolean);

// 알림 시험은 먼저 한 번 돌려 상태 파일을 만든다(상태 파일 없이 처음 읽는 기록은 설치 직후의 지난 일이라 알리지 않는다).
test("처음 쓰는 계정이 빈 목록을 읽으면 폴더를 채우고 「한 번만 껐다 켜」 알림을 한 번 보낸다", () => {
  const t = setup("first-login");
  t.put("A", "local_f1.json", { sessionId: "local_f1", cliSessionId: "55555555-5555-4555-8555-555555555555" });
  t.run();
  t.log(initLine(ACCT.B, 0) + loadedLine(ACCT.B, 0));
  t.run();
  assert.ok(t.has("B", "local_f1.json"), "처음 쓰는 계정 폴더를 채워야 한다");
  assert.match(t.notes(), /한 번만 껐다 켜/);
  assert.match(t.notes(), /이전 세션 1개/);
  t.run();
  assert.equal(noteLines(t).length, 1, "다시 돌려도 같은 일로 두 번 알리면 안 된다");
});

test("설치 직후 첫 맞추기는 지난 기록의 「Loaded 0」에 알리지 않지만 폴더는 채운다", () => {
  const t = setup("history");
  t.put("A", "local_h1.json", { sessionId: "local_h1", cliSessionId: "12121212-1212-4121-8121-121212121212" });
  t.log(initLine(ACCT.B, 0) + loadedLine(ACCT.B, 0));
  t.run();
  assert.ok(t.has("B", "local_h1.json"));
  assert.equal(t.notes(), "", "설치기가 이미 껐다 켜라고 하므로 지난 기록으로 알림을 띄우지 않는다");
});

test("이미 아는 계정으로 바꾸면(existingSessions=0 뒤 Loaded N) 알리지 않는다", () => {
  const t = setup("known-switch");
  t.put("A", "local_k1.json", { sessionId: "local_k1", cliSessionId: "13131313-1313-4131-8131-131313131313" });
  t.run();
  t.log(initLine(ACCT.B, 0) + loadedLine(ACCT.B, 1));
  t.run();
  assert.equal(t.notes(), "");
});

test("한 번에 두 계정 줄이 섞여 읽혀도 처음 쓰는 계정만 한 번 알린다", () => {
  const t = setup("mixed");
  t.put("A", "local_m1.json", { sessionId: "local_m1", cliSessionId: "14141414-1414-4141-8141-141414141414" });
  t.run();
  t.log(initLine(ACCT.A, 1) + loadedLine(ACCT.A, 0) + initLine(ACCT.B, 0) + loadedLine(ACCT.B, 0));
  t.run();
  assert.equal(noteLines(t).length, 1);
  assert.match(t.notes(), /이전 세션 1개/);
});

test("사용자 이름에 공백이 있는 경로(C:\\Users\\Hong Gildong)의 기록도 알아본다", () => {
  const t = setup("space-path");
  t.put("A", "local_sp.json", { sessionId: "local_sp", cliSessionId: "15151515-1515-4151-8151-151515151515" });
  t.run();
  t.log(initLine(ACCT.B, 0) + loadedLine(ACCT.B, 0, "C:\\Users\\Hong Gildong"));
  t.run();
  assert.match(t.notes(), /한 번만 껐다 켜/);
});

test("같은 계정으로 다시 로그인했을 때(existingSessions>0 뒤 Loaded 0)는 알리지 않는다", () => {
  const t = setup("same-user");
  t.put("A", "local_r1.json", { sessionId: "local_r1", cliSessionId: "66666666-6666-4666-8666-666666666666" });
  t.run();
  t.log(initLine(ACCT.A, 1) + loadedLine(ACCT.A, 0));
  t.run();
  assert.equal(t.notes(), "", "목록이 이미 보이는데 껐다 켜라고 하면 안 된다");
});

test("로그인 줄과 「Loaded 0」 줄이 다른 바퀴에 읽혀도 같은 계정 재로그인은 알리지 않는다", () => {
  const t = setup("split-read");
  t.put("A", "local_p1.json", { sessionId: "local_p1", cliSessionId: "77777777-7777-4777-8777-777777777777" });
  t.log(initLine(ACCT.A, 1));
  t.run();
  t.log(loadedLine(ACCT.A, 0));
  t.run();
  assert.equal(t.notes(), "");
});

test("existingSessions가 없는 옛 앱 기록에서도 빈 목록이면 채우고 알린다", () => {
  const t = setup("old-log");
  t.put("A", "local_o1.json", { sessionId: "local_o1", cliSessionId: "88888888-8888-4888-8888-888888888888" });
  t.run();
  t.log(initLine(ACCT.B) + loadedLine(ACCT.B, 0));
  t.run();
  assert.ok(t.has("B", "local_o1.json"));
  assert.match(t.notes(), /한 번만 껐다 켜/);
});

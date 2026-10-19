// 앱이 데이터를 패키지 밖(%LOCALAPPDATA%\Claude-Data\<패키지 이름 소문자>)으로 옮긴 뒤에도 맞추는지 시험한다(2026-10-19).
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
const FAMILY = "Claude_test0000000";

function setup(name) {
  const root = path.join(HERE, "..", ".test-tmp", `move-${name}`);
  fs.rmSync(root, { recursive: true, force: true });
  const env = {
    ...process.env,
    USERPROFILE: path.join(root, "home"), HOME: path.join(root, "home"),
    LOCALAPPDATA: path.join(root, "local"), APPDATA: path.join(root, "roaming"),
    CLAUDE_SESSION_SHARE_HOME: path.join(root, "share"),
    CLAUDE_SESSION_SHARE_NOTIFY_FILE: path.join(root, "notify.txt"),
  };
  delete env.CLAUDE_CONFIG_DIR;
  for (const d of [env.USERPROFILE, path.join(env.LOCALAPPDATA, "Claude", "logs")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(env.LOCALAPPDATA, "Claude", "logs", "main.log"), "");
  // 옮긴 자리(패키지 밖)와 옛 자리(패키지 안)
  const outside = path.join(env.LOCALAPPDATA, "Claude-Data", FAMILY.toLowerCase());
  const inside = path.join(env.LOCALAPPDATA, "Packages", FAMILY, "LocalCache", "Roaming", "Claude");
  const dir = (base, who) => path.join(base, "claude-code-sessions", ACCT[who], ORG);
  const put = (base, who, name, body, ageSec = 1000) => {
    fs.mkdirSync(dir(base, who), { recursive: true });
    const p = path.join(dir(base, who), name);
    fs.writeFileSync(p, JSON.stringify(body));
    const when = Date.now() / 1000 - ageSec;
    fs.utimesSync(p, when, when);
  };
  const run = (mode = "--once") => {
    const r = spawnSync(process.execPath, [SCRIPT, mode], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout;
  };
  return { env, outside, inside, dir, put, run, has: (base, who, n) => fs.existsSync(path.join(dir(base, who), n)) };
}

test("앱이 데이터를 Claude-Data로 옮긴 뒤에도 그 자리의 계정 폴더끼리 맞춘다", () => {
  const t = setup("outside");
  t.put(t.outside, "A", "local_m1.json", { sessionId: "local_m1", cliSessionId: "11111111-1111-4111-8111-111111111111" });
  fs.mkdirSync(t.dir(t.outside, "B"), { recursive: true });
  fs.mkdirSync(t.inside, { recursive: true });
  fs.writeFileSync(path.join(t.inside, `.user-data-left.${FAMILY.toLowerCase()}`), "");
  t.run();
  assert.ok(t.has(t.outside, "B", "local_m1.json"), "옮긴 자리의 B 폴더로 퍼져야 한다");
  assert.ok(!fs.existsSync(path.join(t.inside, "claude-code-sessions")), "떠난 옛 자리에 세션 폴더를 다시 만들면 안 된다");
  const out = t.run("--status");
  assert.match(out, /Claude-Data/);
  assert.match(out, /○ 2곳이 모두 같습니다\(세션 1개\)/);
});

test("두 곳에 다 있으면 떠났다는 표식이 있는 패키지 안 사본은 맞추지 않는다", () => {
  const t = setup("both");
  t.put(t.inside, "A", "local_old.json", { sessionId: "local_old", cliSessionId: "22222222-2222-4222-8222-222222222222" });
  fs.writeFileSync(path.join(t.inside, `.user-data-left.${FAMILY.toLowerCase()}`), "");
  t.put(t.outside, "A", "local_new.json", { sessionId: "local_new", cliSessionId: "33333333-3333-4333-8333-333333333333" });
  fs.mkdirSync(t.dir(t.outside, "B"), { recursive: true });
  t.run();
  assert.ok(t.has(t.outside, "B", "local_new.json"), "옮긴 자리끼리는 맞춘다");
  assert.ok(!t.has(t.inside, "A", "local_new.json"), "앱이 쓰지 않는 옛 사본에 쓰면 안 된다");
  assert.ok(!t.has(t.outside, "B", "local_old.json"), "옛 사본의 기록을 끌어오면 안 된다");
});

test("표식 없이 패키지 안에만 있으면(앱이 다시 안으로 옮김) 그쪽을 맞춘다", () => {
  const t = setup("back");
  t.put(t.inside, "A", "local_b1.json", { sessionId: "local_b1", cliSessionId: "44444444-4444-4444-8444-444444444444" });
  fs.mkdirSync(t.dir(t.inside, "B"), { recursive: true });
  t.run();
  assert.ok(t.has(t.inside, "B", "local_b1.json"));
  assert.ok(!fs.existsSync(path.join(t.env.LOCALAPPDATA, "Claude-Data")), "패키지 밖 자리를 새로 만들면 안 된다");
});

test("맞춘 뒤 사라진 짝 폴더를 다시 만들 때 비어 있다고 다른 폴더의 기록을 지우지 않는다", () => {
  const t = setup("vanished");
  t.put(t.outside, "A", "local_v1.json", { sessionId: "local_v1", cliSessionId: "55555555-5555-4555-8555-555555555555" });
  fs.mkdirSync(t.dir(t.outside, "B"), { recursive: true });
  // 앱 기록에 두 계정이 로그인한 줄이 있어 둘 다 「알던 짝」이 된다.
  const init = (acct) => `2026-10-19 21:32:16 [info] [LocalSessionManager] Initialization succeeded — accountId=${acct}, orgId=${ORG}, existingSessions=0\n`;
  fs.appendFileSync(path.join(t.env.LOCALAPPDATA, "Claude", "logs", "main.log"), init(ACCT.A) + init(ACCT.B));
  t.run();
  assert.ok(t.has(t.outside, "B", "local_v1.json"));
  fs.rmSync(t.dir(t.outside, "B"), { recursive: true, force: true });
  t.run();
  assert.ok(t.has(t.outside, "A", "local_v1.json"), "B 폴더가 사라졌다고 A의 기록을 지우면 안 된다");
  assert.ok(t.has(t.outside, "B", "local_v1.json"), "다시 만든 B 폴더는 A의 기록으로 채운다");
});

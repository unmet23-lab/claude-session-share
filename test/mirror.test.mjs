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
  };
  delete env.CLAUDE_CONFIG_DIR;
  for (const d of [env.USERPROFILE, path.join(env.LOCALAPPDATA, "Claude", "logs")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(env.LOCALAPPDATA, "Claude", "logs", "main.log"), "");
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

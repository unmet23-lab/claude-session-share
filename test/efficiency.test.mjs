// 쓰기를 줄인 판(2026-10-20)의 시험: 고쳐 쓴 기록 모아 옮기기, 로그인·로그아웃 줄이면 바로 맞추기,
// 로그인 기록이 없는 짝 폴더 쉬게 하기와 그 짝의 첫 로그인, 바뀐 것이 없으면 상태 파일을 쓰지 않기.
// 가짜 앱 데이터 폴더로 --once와 지켜보기(인자 없이 실행)를 돌린다. 실제 앱 데이터·상태 폴더는 건드리지 않는다.
// 실행: 저장소 폴더에서 node --test   (PowerShell에서. 스토어 앱 안 터미널에서는 AppData가 돌려질 수 있다)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.CLAUDE_SESSION_SHARE_SCRIPT || path.join(HERE, "..", "claude-session-share.mjs");
const ORG = "0000000a-0000-4000-8000-00000000000f";
const ACCT = { A: "aaaaaaaa-0000-4000-8000-000000000001", B: "bbbbbbbb-0000-4000-8000-000000000002", C: "cccccccc-0000-4000-8000-000000000003", D: "dddddddd-0000-4000-8000-000000000004" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 앱 기록 줄. 로그인 줄이 30초 안에 다른 짝 로그인 줄로 이어지면 「지나가는 로그인」이라 시각을 일부러 떨어뜨린다.
const initLine = (acct, existing = 0, at = "2026-10-20 08:50:58") =>
  `${at} [info] [LocalSessionManager] Initialization succeeded — accountId=${acct}, orgId=${ORG}, existingSessions=${existing}\n`;
const loadedLine = (acct, n, at = "2026-10-20 08:52:00") =>
  `${at} [info] Loaded ${n} persisted sessions from C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code-sessions\\${acct}\\${ORG}\n`;
const logoutLine = () => "2026-10-20 08:59:00 [info] [LocalSessionManager] Account logged out, marking for re-init on next login\n";
// B와 A가 차례로 로그인한 기록(1분 넘게 떨어져 둘 다 진짜 로그인, 지금 계정은 A)
const twoLogins = () => initLine(ACCT.B, 0, "2026-10-20 08:50:58") + initLine(ACCT.A, 0, "2026-10-20 08:52:30");
// 이 PC 시각으로 「YYYY-MM-DD HH:MM:SS」(지켜보기 시험에서 지금 일어난 로그인처럼 쓰려고)
const stamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

function setup(name, who = ["A", "B"]) {
  const root = path.join(HERE, "..", ".test-tmp", `eff-${name}`);
  fs.rmSync(root, { recursive: true, force: true });
  const env = {
    ...process.env,
    USERPROFILE: path.join(root, "home"), HOME: path.join(root, "home"),
    LOCALAPPDATA: path.join(root, "local"), APPDATA: path.join(root, "roaming"),
    CLAUDE_SESSION_SHARE_HOME: path.join(root, "share"),
    CLAUDE_SESSION_SHARE_NOTIFY_FILE: path.join(root, "notify.txt"), // 진짜 윈도 알림을 띄우지 않는다
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_SESSION_SHARE_BATCH_MS;
  delete env.CLAUDE_SESSION_SHARE_PARK_MIN_AGE_MS;
  delete env.CLAUDE_SESSION_SHARE_VERBOSE;
  const logs = path.join(env.LOCALAPPDATA, "Claude", "logs");
  for (const d of [env.USERPROFILE, logs]) fs.mkdirSync(d, { recursive: true });
  const mainLog = path.join(logs, "main.log");
  fs.writeFileSync(mainLog, "");
  const tree = path.join(env.APPDATA, "Claude", "claude-code-sessions");
  const dir = (w) => path.join(tree, ACCT[w], ORG);
  for (const w of who) fs.mkdirSync(dir(w), { recursive: true });
  const children = [];
  const s = {
    root, env, dir, logs,
    // ageSec초 전 시각으로 쓴다(0이면 지금).
    put(w, name, body, ageSec = 1000) {
      const p = path.join(dir(w), name);
      fs.writeFileSync(p, JSON.stringify(body));
      const when = Date.now() / 1000 - ageSec;
      fs.utimesSync(p, when, when);
    },
    read(w, name) { try { return JSON.parse(fs.readFileSync(path.join(dir(w), name), "utf8")); } catch { return null; } },
    has: (w, name) => fs.existsSync(path.join(dir(w), name)),
    log: (text) => fs.appendFileSync(mainLog, text),
    notes: () => (fs.existsSync(env.CLAUDE_SESSION_SHARE_NOTIFY_FILE) ? fs.readFileSync(env.CLAUDE_SESSION_SHARE_NOTIFY_FILE, "utf8") : ""),
    shareLog() { try { return fs.readFileSync(path.join(env.CLAUDE_SESSION_SHARE_HOME, "claude-session-share.log"), "utf8"); } catch { return ""; } },
    statePath: path.join(env.CLAUDE_SESSION_SHARE_HOME, "claude-session-share.json"),
    run(mode = "--once", extra = {}) {
      const r = spawnSync(process.execPath, [SCRIPT, mode], { env: { ...env, ...extra }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      return r.stdout;
    },
    // 지켜보기(시작프로그램이 띄우는 것과 같은 실행)를 띄운다. 시험이 끝나면 끈다.
    start(extra = {}) {
      const c = spawn(process.execPath, [SCRIPT], { env: { ...env, ...extra }, stdio: "ignore", windowsHide: true });
      children.push(c);
      return c;
    },
    stop() { for (const c of children) { try { c.kill(); } catch {} } },
  };
  return s;
}

// 받는 폴더 파일을 너무 자주 열면 미러의 이름 바꾸기와 겹쳐 그 복사가 한 번 실패한다(곧 다시 한다). 그래서 0.25초 간격으로 본다.
async function waitFor(fn, timeoutMs = 8000, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() >= end) return false;
    await sleep(stepMs);
  }
}

// 기록 줄 가운데 since(ms) 뒤에 남은 것
const linesSince = (text, since) => text.split("\n").filter((l) => l && Date.parse(l.slice(0, 24)) >= since);

test("고쳐 쓴 세션 기록은 모았다가 마지막 판만 한 번 옮기고, 새 기록은 바로 옮긴다", async (t) => {
  const s = setup("batch");
  t.after(() => s.stop());
  s.log(twoLogins()); // 둘 다 로그인한 적 있는 짝, 지금 계정은 A
  s.put("A", "local_b1.json", { v: 1 });
  s.start({ CLAUDE_SESSION_SHARE_BATCH_MS: "4000" });
  assert.ok(await waitFor(() => s.read("B", "local_b1.json")?.v === 1), "켜자마자 한 번 다 맞춘다");
  await sleep(1500);
  const t0 = Date.now();
  for (let v = 2; v <= 4; v++) { s.put("A", "local_b1.json", { v }, 0); await sleep(400); }
  assert.equal(s.read("B", "local_b1.json")?.v, 1, "모으는 동안(4초)에는 옮기지 않는다");
  assert.ok(await waitFor(() => s.read("B", "local_b1.json")?.v === 4, 10000), "모은 뒤 마지막 판을 옮긴다");
  // 성공한 복사만 센다(받는 쪽 파일을 시험이 읽는 순간과 겹친 한 번은 실패로 남고 곧 다시 한다).
  const copies = linesSince(s.shareLog(), t0 - 100).filter((l) => l.includes("+local_b1.json") && !/ 0개 복사/.test(l));
  assert.equal(copies.length, 1, `세 번 고쳐 쓴 것을 한 번만 옮겨야 한다:\n${copies.join("\n")}`);
  assert.match(copies[0], / 1개 복사/);
  assert.ok(Date.parse(copies[0].slice(0, 24)) - t0 >= 3500, "모으는 시간(4초)이 지난 뒤에 옮겼다");
  s.put("A", "local_b2.json", { v: 1 }, 0);
  assert.ok(await waitFor(() => s.read("B", "local_b2.json"), 2500), "새 기록은 모으지 않고 바로 옮긴다");
});

test("로그아웃 줄을 보면 모으던 것을 바로 옮겨 다음 계정 폴더가 최신이 되고, 다시 로그인하면 또 모은다", async (t) => {
  const s = setup("logout");
  t.after(() => s.stop());
  s.log(twoLogins());
  s.put("A", "local_l1.json", { v: 1 });
  s.start({ CLAUDE_SESSION_SHARE_BATCH_MS: "30000" });
  assert.ok(await waitFor(() => s.read("B", "local_l1.json")?.v === 1));
  await sleep(1200);
  s.put("A", "local_l1.json", { v: 2 }, 0);
  await sleep(1500);
  assert.equal(s.read("B", "local_l1.json")?.v, 1, "로그인 중에 고쳐 쓴 것은 모은다");
  s.log(logoutLine());
  // 앱은 다음 계정으로 로그인할 때 그 계정 폴더를 읽는다. 그 전에(로그아웃 줄을 본 즉시) 최신이어야 한다.
  assert.ok(await waitFor(() => s.read("B", "local_l1.json")?.v === 2, 3000), "로그아웃 줄을 보면 기다리지 않고 옮긴다");
  assert.match(s.shareLog(), /로그아웃 줄을 봄/, "기록에 왜 바로 맞췄는지 남긴다");
  s.put("A", "local_l1.json", { v: 3 }, 0);
  assert.ok(await waitFor(() => s.read("B", "local_l1.json")?.v === 3, 3000), "로그아웃 뒤 다음 로그인까지는 모으지 않는다");
  s.log(initLine(ACCT.B, 0) + loadedLine(ACCT.B, 1));
  await sleep(1500);
  s.put("B", "local_l1.json", { v: 4 }, 0);
  await sleep(1500);
  assert.equal(s.read("A", "local_l1.json")?.v, 3, "로그인한 뒤로는 다시 모은다");
  assert.equal(s.notes(), "", "이미 맞춰 둔 계정으로 바꾼 것이라 껐다 켜라고 하지 않는다");
});

test("로그아웃 줄 없이 다른 계정의 로그인 줄이 보여도 기다리지 않고 바로 전부 맞춘다", async (t) => {
  const s = setup("login");
  t.after(() => s.stop());
  s.log(twoLogins());
  s.put("A", "local_g1.json", { v: 1 });
  s.start({ CLAUDE_SESSION_SHARE_BATCH_MS: "30000" });
  assert.ok(await waitFor(() => s.read("B", "local_g1.json")?.v === 1));
  await sleep(1200);
  s.put("A", "local_g1.json", { v: 2 }, 0);
  await sleep(1500);
  assert.equal(s.read("B", "local_g1.json")?.v, 1);
  s.log(initLine(ACCT.B, 0) + loadedLine(ACCT.B, 1));
  assert.ok(await waitFor(() => s.read("B", "local_g1.json")?.v === 2, 3000), "로그인 줄을 보면 바로 맞춘다");
  assert.match(s.shareLog(), /로그인 줄을 봄\(bbbbbbbb\/0000000a\)/);
});

test("로그인 기록이 없는 짝 폴더는 먼저 합친 뒤 쉬게 하고, 그 짝으로 처음 로그인하면 채우고 「껐다 켜기」를 알린다", () => {
  const s = setup("park", ["A", "B", "C"]);
  const env = { CLAUDE_SESSION_SHARE_PARK_MIN_AGE_MS: "0" };
  s.log(twoLogins()); // C는 로그인한 적이 없다
  s.put("A", "local_p1.json", { sessionId: "local_p1", cliSessionId: "11111111-1111-4111-8111-111111111111" });
  s.put("C", "local_c1.json", { sessionId: "local_c1", cliSessionId: "22222222-2222-4222-8222-222222222222" }, 900);
  s.run("--once", env);
  assert.ok(s.has("B", "local_c1.json"), "쉬게 하기 전에 C에만 있던 기록을 먼저 합친다");
  assert.ok(s.has("C", "local_p1.json"));
  s.run("--once", env);
  assert.ok(!fs.existsSync(s.dir("C")), "로그인 기록이 없는 C 폴더는 쉬게 한다(백업 폴더로 옮김)");
  const backups = path.join(s.env.CLAUDE_SESSION_SHARE_HOME, "claude-session-backups");
  const parked = fs.readdirSync(backups).filter((n) => n.endsWith("-parked"));
  assert.equal(parked.length, 1);
  assert.ok(fs.existsSync(path.join(backups, parked[0], "claude-code-sessions", ACCT.C, ORG, "local_p1.json")), "옮긴 곳에 그대로 있다");
  let out = s.run("--status", env);
  assert.match(out, /○ 2곳이 모두 같습니다\(세션 2개\)/);
  assert.match(out, /쉬는 짝 폴더 1곳/);
  s.put("A", "local_p2.json", { sessionId: "local_p2", cliSessionId: "33333333-3333-4333-8333-333333333333" }, 500);
  s.run("--once", env);
  assert.ok(s.has("B", "local_p2.json"));
  assert.ok(!fs.existsSync(s.dir("C")), "쉬는 짝 폴더는 다시 만들지 않고 복사하지 않는다");
  // 그 짝으로 처음 로그인: 앱이 빈 폴더를 새로 만들고 세션 0개를 읽는다.
  fs.mkdirSync(s.dir("C"), { recursive: true });
  s.log(initLine(ACCT.C, 0) + loadedLine(ACCT.C, 0));
  s.run("--once", env);
  for (const n of ["local_p1.json", "local_p2.json", "local_c1.json"]) assert.ok(s.has("C", n), `처음 로그인한 C 폴더를 채운다: ${n}`);
  assert.match(s.notes(), /한 번만 껐다 켜/);
  s.run("--once", env);
  assert.ok(fs.existsSync(s.dir("C")), "로그인한 짝은 다시 쉬게 하지 않는다");
  out = s.run("--status", env);
  assert.match(out, /○ 3곳이 모두 같습니다\(세션 3개\)/);
  assert.doesNotMatch(out, /쉬는 짝 폴더/);
});

test("앱 기록을 못 읽었거나, 만든 지 얼마 안 됐거나, 넘어간 앱 기록에 로그인이 있으면 쉬게 하지 않는다", () => {
  // 앱 기록이 없다: 로그인 기록이 없는지 알 수 없다
  const s = setup("nopark", ["A", "B", "C"]);
  fs.rmSync(path.join(s.logs, "main.log"));
  s.put("A", "local_n1.json", { sessionId: "local_n1", cliSessionId: "44444444-4444-4444-8444-444444444444" });
  s.run("--once", { CLAUDE_SESSION_SHARE_PARK_MIN_AGE_MS: "0" });
  s.run("--once", { CLAUDE_SESSION_SHARE_PARK_MIN_AGE_MS: "0" });
  assert.ok(s.has("C", "local_n1.json"), "앱 기록을 못 읽으면 쉬게 하지 않고 그대로 맞춘다");
  // 만든 지 한 시간이 안 됐다(기본값)
  const y = setup("young", ["A", "B", "C"]);
  y.log(twoLogins());
  y.put("A", "local_y1.json", { sessionId: "local_y1", cliSessionId: "55555555-5555-4555-8555-555555555555" });
  y.run();
  y.run();
  assert.ok(y.has("C", "local_y1.json"), "앱이 막 만들었을 수 있는 폴더는 쉬게 하지 않는다");
  // 넘어간 앱 기록(main1.log)에 C의 로그인이 있다
  const o = setup("rotated", ["A", "B", "C"]);
  o.log(twoLogins());
  fs.writeFileSync(path.join(o.logs, "main1.log"), initLine(ACCT.C, 0, "2026-10-19 21:00:00") + loadedLine(ACCT.C, 3, "2026-10-19 21:00:01"));
  o.put("A", "local_o1.json", { sessionId: "local_o1", cliSessionId: "66666666-6666-4666-8666-666666666666" });
  o.run("--once", { CLAUDE_SESSION_SHARE_PARK_MIN_AGE_MS: "0" });
  o.run("--once", { CLAUDE_SESSION_SHARE_PARK_MIN_AGE_MS: "0" });
  assert.ok(o.has("C", "local_o1.json"), "넘어간 앱 기록에 로그인이 있으면 로그인한 짝으로 보고 계속 맞춘다");
});

test("바뀐 것이 없으면 상태 파일을 쓰지 않고, 우리가 옮겨 쓴 폴더를 다시 훑지 않는다", async (t) => {
  const s = setup("idle");
  t.after(() => s.stop());
  s.log(twoLogins());
  s.put("A", "local_i1.json", { v: 1 });
  s.start({ CLAUDE_SESSION_SHARE_BATCH_MS: "1500", CLAUDE_SESSION_SHARE_VERBOSE: "1" });
  assert.ok(await waitFor(() => s.read("B", "local_i1.json") && fs.existsSync(s.statePath)), "켜자마자 맞추고 상태를 남긴다");
  await sleep(3000);
  const before = fs.statSync(s.statePath).mtimeMs;
  const t0 = Date.now();
  // 앱이 하듯 임시 파일을 만들었다 지워(폴더 시각만 바뀜) 다시 훑게 하고, main.log에도 다른 줄을 계속 더한다.
  for (let i = 0; i < 10; i++) {
    const tmp = path.join(s.dir("A"), `local_i1.json.tmp`);
    fs.writeFileSync(tmp, "{}");
    fs.unlinkSync(tmp);
    s.log(`2026-10-20 12:00:0${i} [info] [Something] unrelated line\n`);
    await sleep(500);
  }
  await sleep(2000);
  const rescans = linesSince(s.shareLog(), t0).filter((l) => l.includes(" 훑기 "));
  assert.ok(rescans.length >= 1, "폴더 시각이 바뀌어 다시 훑기는 했다");
  assert.equal(fs.statSync(s.statePath).mtimeMs, before, "훑어도 바뀐 것이 없으면 상태 파일을 다시 쓰지 않는다");
  // 새 기록 하나를 B로 옮긴 뒤, 그 쓰기 때문에 B를 다시 훑지 않는다
  const t1 = Date.now();
  s.put("A", "local_i2.json", { v: 1 }, 0);
  assert.ok(await waitFor(() => s.read("B", "local_i2.json"), 3000));
  await sleep(3500);
  const after = linesSince(s.shareLog(), t1);
  const scans = after.filter((l) => l.includes(" 훑기 "));
  assert.ok(scans.length >= 1);
  assert.ok(scans.every((l) => !l.includes("bbbbbbbb/")), `B를 다시 훑으면 안 된다:\n${after.join("\n")}`);
});

// B로 일하다 로그아웃 → 앱이 C 짝을 4초 거친 뒤 A로 로그인한 기록(C는 지나가는 로그인)
const passingLogins = () =>
  initLine(ACCT.B, 0, "2026-10-20 08:00:00") + "2026-10-20 08:30:00 [info] [LocalSessionManager] Account logged out, marking for re-init on next login\n" +
  initLine(ACCT.C, 40, "2026-10-20 08:31:00") + initLine(ACCT.A, 40, "2026-10-20 08:31:04") + loadedLine(ACCT.A, 1, "2026-10-20 08:31:05");

test("앱이 계정을 바꾸며 몇 초만 거친 짝은 로그인 기록으로 치지 않아, 그 빈 폴더를 채우지 않고 나중에 쉬게 한다", () => {
  const s = setup("transient", ["A", "B", "C"]);
  s.log(passingLogins());
  s.put("A", "local_t1.json", { sessionId: "local_t1", cliSessionId: "77777777-7777-4777-8777-777777777777" });
  fs.writeFileSync(path.join(s.dir("C"), "scheduled-tasks.json"), JSON.stringify({ scheduledTasks: [] })); // 앱이 거치며 쓴 빈 예약 목록
  s.run();
  assert.ok(s.has("B", "local_t1.json"), "진짜 로그인한 B는 맞춘다");
  assert.ok(!s.has("C", "local_t1.json"), "몇 초만 거친 C의 빈 폴더는 채우지 않는다");
  assert.match(s.shareLog(), /cccccccc\/0000000a: 앱이 계정을 바꾸며 4초만 거친 짝/);
  let out = s.run("--status");
  assert.match(out, /○ 2곳이 모두 같습니다\(세션 1개\)/, "판정에서 뺀다");
  assert.match(out, /cccccccc-0000-4000-8000-000000000003\/0000000a-0000-4000-8000-00000000000f  \(앱이 계정을 바꾸며 잠깐 거친 짝/);
  s.run("--once", { CLAUDE_SESSION_SHARE_PARK_MIN_AGE_MS: "0" });
  assert.ok(!fs.existsSync(s.dir("C")), "맞출 것이 없으니 합치지 않고 바로 쉬게 한다");
  out = s.run("--status");
  assert.match(out, /쉬는 짝 폴더 1곳/);
});

test("이전 판이 알려진 짝으로 넣어 둔 지나가는 로그인 짝은 켤 때 빼고 쉬게 한다", () => {
  const s = setup("demote", ["A", "B", "C"]);
  s.log(passingLogins());
  s.put("A", "local_m1.json", { sessionId: "local_m1", cliSessionId: "88888888-8888-4888-8888-888888888888" });
  s.run();
  // 이전 판이 남긴 모습: C도 알려진 짝이고 다른 폴더와 맞춰져 있다.
  fs.copyFileSync(path.join(s.dir("A"), "local_m1.json"), path.join(s.dir("C"), "local_m1.json"));
  const state = JSON.parse(fs.readFileSync(s.statePath, "utf8"));
  state.known[`${ACCT.C}/${ORG}`] = "2026-10-17T05:56:29.001Z";
  delete state.transient;
  state.synced["claude-code-sessions"].push(s.dir("C"));
  fs.writeFileSync(s.statePath, JSON.stringify(state));
  s.run("--once", { CLAUDE_SESSION_SHARE_PARK_MIN_AGE_MS: "0" });
  assert.match(s.shareLog(), /몇 초만 거친 짝 1곳을 로그인 기록에서 뺌\(cccccccc\/0000000a\)/);
  assert.ok(!fs.existsSync(s.dir("C")), "알려진 짝에서 빠지고 맞춰져 있으니 쉬게 한다");
  assert.ok(s.has("B", "local_m1.json"), "진짜 로그인한 짝은 그대로 맞춘다");
  const after = JSON.parse(fs.readFileSync(s.statePath, "utf8"));
  assert.equal(after.known[`${ACCT.C}/${ORG}`], undefined);
});

test("처음 쓰는 짝의 로그인은 지나가는 로그인인지 몇 초 지켜본 뒤 채우고 알리고, 지나가는 로그인은 채우지도 알리지도 않는다", async (t) => {
  const s = setup("pending");
  t.after(() => s.stop());
  s.log(twoLogins());
  s.put("A", "local_n1.json", { sessionId: "local_n1", cliSessionId: "99999999-9999-4999-8999-999999999999" });
  s.start({ CLAUDE_SESSION_SHARE_BATCH_MS: "30000", CLAUDE_SESSION_SHARE_TRANSIENT_MS: "4000" });
  assert.ok(await waitFor(() => s.read("B", "local_n1.json")));
  await sleep(1500);
  // 진짜 첫 로그인: 앱이 C 폴더를 새로 만들고 세션 0개를 읽는다.
  fs.mkdirSync(s.dir("C"), { recursive: true });
  s.log(initLine(ACCT.C, 0, stamp()) + loadedLine(ACCT.C, 0, stamp()));
  await sleep(1500);
  assert.ok(!s.has("C", "local_n1.json"), "지나가는 로그인인지 판정하기 전에는 채우지 않는다");
  assert.ok(await waitFor(() => s.has("C", "local_n1.json"), 10000), "판정한 뒤 채운다");
  assert.ok(await waitFor(() => /한 번만 껐다 켜/.test(s.notes()), 5000), "빈 목록을 읽었으니 껐다 켜기를 알린다");
  // 지나가는 로그인: D 짝을 1초 거쳐 A로
  const notes = s.notes();
  fs.mkdirSync(s.dir("D"), { recursive: true });
  s.log(initLine(ACCT.D, 9, stamp()) + loadedLine(ACCT.D, 0, stamp()));
  await sleep(1000);
  s.log(initLine(ACCT.A, 9, stamp()) + loadedLine(ACCT.A, 2, stamp()));
  await sleep(6000);
  assert.ok(!s.has("D", "local_n1.json"), "지나가는 로그인 짝의 빈 폴더는 채우지 않는다");
  assert.equal(s.notes(), notes, "지나가는 로그인에는 알리지 않는다");
  assert.match(s.shareLog(), /dddddddd\/0000000a: 앱이 계정을 바꾸며 \d+초만 거친 짝/);
});

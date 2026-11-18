import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { command, sandboxEnv, testRoot } from "../test-support/runner.mjs";

test("상주 프로세스가 수동 맞추기와 종료 요청을 처리하고 상태를 이어받는다", {
  skip: !process.env.CLAUDE_SESSION_SHARE_TEST_EXE,
  timeout: 30000
}, async (t) => {
  const home = path.join(testRoot, "home");
  const local = path.join(testRoot, "local");
  const roaming = path.join(testRoot, "roaming");
  const data = path.join(testRoot, "share");
  const env = { ...sandboxEnv, HOME: home, USERPROFILE: home, LOCALAPPDATA: local, APPDATA: roaming,
    CLAUDE_SESSION_SHARE_HOME: data, CLAUDE_SESSION_SHARE_NOTIFY_FILE: path.join(testRoot, "notifications.txt") };
  const options = { env, windowsHide: true, encoding: "utf8", timeout: 10000 };
  const run = (...args) => {
    const result = spawnSync(command, args, options);
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return result.stdout;
  };
  const org = "0000000a-0000-4000-8000-00000000000f";
  const pair = (id) => path.join(roaming, "Claude", "claude-code-sessions", id, org);
  const a = pair("aaaaaaaa-0000-4000-8000-000000000001");
  const b = pair("bbbbbbbb-0000-4000-8000-000000000002");
  for (const dir of [a,b,home,local]) fs.mkdirSync(dir, { recursive:true });
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    oauthAccount:{ accountUuid:path.basename(path.dirname(b)), organizationUuid:org }
  }));
  const older = b+"-older-copy";
  fs.mkdirSync(older);
  fs.writeFileSync(path.join(older,"scheduled-tasks.json"),JSON.stringify({scheduledTasks:[]}));
  const name = "local_example.json";
  const state = path.join(data, "claude-session-share.json");
  fs.writeFileSync(path.join(a, name), '{"v":1}');
  run("--backup-only");
  assert.equal(fs.existsSync(path.join(b, name)), false);
  assert.equal(fs.existsSync(state), false);
  assert.equal(fs.readdirSync(path.join(data, "claude-session-backups")).length, 1);

  const child = spawn(command, [], {env, stdio:"ignore", windowsHide:true});
  t.after(() => {if (child.exitCode === null) child.kill();});
  const until = Date.now()+10000;
  while (!fs.existsSync(path.join(b,name)) && Date.now()<until) await delay(50);
  assert.equal(fs.readFileSync(path.join(b, name), "utf8"), '{"v":1}');
  assert.match(run(), /이미 실행 중/);
  fs.writeFileSync(path.join(a, name), '{"v":2}');
  run("--once");
  assert.equal(fs.readFileSync(path.join(b, name), "utf8"), '{"v":2}');
  assert.equal(Number(fs.readFileSync(path.join(data, "claude-session-share.pid"), "utf8")), child.pid);
  fs.renameSync(b, b + "-moved");
  run("--once");
  assert.equal(fs.readFileSync(path.join(b, name), "utf8"), '{"v":2}');
  fs.writeFileSync(path.join(b, "local_rebound.json"), "{}");
  const deadline = Date.now()+4000;
  while (!fs.existsSync(path.join(a, "local_rebound.json")) && Date.now()<deadline) await delay(50);
  assert.equal(fs.existsSync(path.join(a, "local_rebound.json")), true, "다시 만든 폴더에서도 신규 파일을 즉시 감지한다");
  run("--stop");
  assert.equal(fs.existsSync(path.join(data, "claude-session-share.pid")), false);
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).v, 2);
  fs.unlinkSync(path.join(b, name));
  run("--once");
  assert.equal(fs.existsSync(path.join(a, name)), false, "같은 폴더에서 사용자가 지운 파일은 전파한다");

  // Claude can replace the entire pair at the same path while the service is off or still running.
  const keep = "local_rebound.json";
  const registry = "scheduled-tasks.json";
  const jobs = (dir) => JSON.parse(fs.readFileSync(path.join(dir,registry),"utf8")).scheduledTasks.map(t=>t.id);
  fs.writeFileSync(path.join(b,registry),JSON.stringify({scheduledTasks:[{id:"T"}]}));
  run("--once");
  assert.deepEqual(jobs(a),["T"]);
  await delay(100);
  fs.renameSync(b, b+"-offline");
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b,registry), JSON.stringify({scheduledTasks:[]}));
  run("--once");
  for (const dir of [a,b]) assert.deepEqual(jobs(dir),["T"],"교체된 폴더의 빈 예약 목록은 다른 계정 예약을 지우지 않는다");
  for (const dir of [a,b]) assert.equal(fs.readFileSync(path.join(dir,keep),"utf8"),"{}");
  assert.ok(fs.statSync(older).birthtimeMs < fs.statSync(state).mtimeMs);
  fs.renameSync(b,b+"-before-restore");
  fs.renameSync(older,b);
  run("--once");
  for (const dir of [a,b]) {
    assert.equal(fs.readFileSync(path.join(dir,keep),"utf8"),"{}");
    assert.deepEqual(jobs(dir),["T"],"오래된 폴더를 복원해도 세션과 예약을 지키고 다시 채운다");
  }
  const live = spawn(command, [], {env, stdio:"ignore", windowsHide:true});
  t.after(() => {if (live.exitCode === null) live.kill();});
  run("--once"); // synchronize startup before replacing the directory
  await delay(1500);
  fs.renameSync(b,b+"-online");
  fs.mkdirSync(b);
  const limit = Date.now()+4500;
  while (!fs.existsSync(path.join(b,keep)) && Date.now()<limit) await delay(50);
  for (const dir of [a,b]) assert.equal(fs.readFileSync(path.join(dir,keep),"utf8"),"{}");
  run("--stop");
});

test("상태 저장 실패와 채우는 중 강제 종료 뒤에도 다른 계정의 원본을 보존한다", {
  skip: !process.env.CLAUDE_SESSION_SHARE_TEST_EXE,
  timeout: 45000
}, async (t) => {
  const root = path.join(testRoot, "crash");
  const org = "0000000a-0000-4000-8000-00000000000f";
  const acct = "bbbbbbbb-0000-4000-8000-000000000002";
  const data = path.join(root, "state");
  const home = path.join(root, "home");
  const local = path.join(root, "local");
  const roaming = path.join(root, "roaming");
  const env = { ...sandboxEnv, HOME: home, USERPROFILE: home, LOCALAPPDATA: local,
    APPDATA: roaming, CLAUDE_SESSION_SHARE_HOME: data,
    CLAUDE_SESSION_SHARE_NOTIFY_FILE: path.join(root, "notify") };
  const run = (...args) => spawnSync(command, args, { env, encoding: "utf8", windowsHide: true, timeout: 10000 });
  const a = path.join(roaming, "Claude", "claude-code-sessions", "aaaaaaaa-0000-4000-8000-000000000001", org);
  const b = path.join(path.dirname(path.dirname(a)), acct, org);
  const src = path.join(a, "local_locked.json");
  const state = path.join(data, "claude-session-share.json");
  const names = ["local_other.json", "local_locked.json"];
  const workers = [];
  const waitFor = async (f) => {
    const end = Date.now()+7000;
    while (!f() && Date.now()<end) await delay(20);
    assert.ok(f());
  };
  const start = () => {
    const c = spawn(command, [], {env, stdio:"ignore", windowsHide:true});
    workers.push(c);
    return c;
  };
  const terminate = async (c) => {
    const exited = new Promise(resolve => c.once("exit",resolve));
    c.kill();
    await exited;
  };
  t.after(() => { for (const c of workers) if (c.exitCode === null) c.kill(); });
  for (const p of [home, local, a, b]) fs.mkdirSync(p, {recursive:true});
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({oauthAccount:{accountUuid:acct,organizationUuid:org}}));
  for (const n of names) fs.writeFileSync(path.join(a, n), '{"keep":true}');
  assert.equal(run("--once").status, 0);
  const synced = () => JSON.parse(fs.readFileSync(state,"utf8")).synced["claude-code-sessions"].includes(b);
  assert.ok(synced());
  fs.renameSync(b, b+"-old");

  // Windows file sharing allows the service to read state, but prevents its atomic replacement.
  // Keep one source file unavailable as well so the second phase stops with an incomplete copy.
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$s=[IO.File]::Open($env:TEST_STATE,'Open','Read','ReadWrite')",
    "$f=[IO.File]::Open($env:TEST_SRC,'Open','Read','None')",
    "$i=[IO.File]::Open($env:TEST_LEDGER,'Open','Read','ReadWrite')",
    "[IO.File]::WriteAllText($env:TEST_READY,'ready')",
    "while (!(Test-Path -LiteralPath $env:TEST_UNLOCK)) { Start-Sleep -Milliseconds 25 }",
    "$s.Dispose()",
    "[IO.File]::WriteAllText($env:TEST_RELEASED,'released')",
    "while (!(Test-Path -LiteralPath $env:TEST_ALLOW_ID)) { Start-Sleep -Milliseconds 25 }",
    "$i.Dispose()",
    "[IO.File]::WriteAllText($env:TEST_ID_DONE,'released')",
    "while (!(Test-Path -LiteralPath $env:TEST_FINISH)) { Start-Sleep -Milliseconds 25 }",
    "$f.Dispose()",
  ].join("\n");
  const flag = (s) => path.join(root,s);
  const holder = spawn("powershell.exe", ["-NoProfile","-NonInteractive","-Command",ps], {
    env: {...env, TEST_STATE:state, TEST_SRC:src, TEST_LEDGER:path.join(data,"claude-session-share-directories.json"), TEST_ALLOW_ID:flag("allow-id"), TEST_ID_DONE:flag("id-done"), TEST_READY:flag("ready"), TEST_UNLOCK:flag("unlock"), TEST_RELEASED:flag("released"), TEST_FINISH:flag("finish")},
    stdio:"ignore", windowsHide:true
  });
  workers.push(holder);
  await waitFor(()=>fs.existsSync(flag("ready")));
  const first = start();
  const pidFile = path.join(data,"claude-session-share.pid");
  await waitFor(()=>fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile,"utf8"))===first.pid);
  for (let i=0;i<2;i++) {
    assert.notEqual(run("--once").status, 0);
    assert.equal(fs.existsSync(b),false,"저장 실패 후 재시도에서도 빈 경로를 만들지 않는다");
  }
  await terminate(first);
  assert.ok(synced(),"이전 상태 파일은 그대로다");
  fs.writeFileSync(flag("unlock"),"");
  await waitFor(()=>fs.existsSync(flag("released")));
  assert.notEqual(run("--once").status,0,"ID 저장에 실패한 폴더는 동기화에 참여할 수 없다");
  assert.equal(fs.existsSync(path.join(a,"local_other.json")),true);
  assert.equal(fs.existsSync(path.join(b,"local_other.json")),false);
  fs.writeFileSync(flag("allow-id"),"");
  await waitFor(()=>fs.existsSync(flag("id-done")));
  const second = start();
  const secondPid = () => { try {return Number(fs.readFileSync(pidFile,"utf8"));} catch {return 0;} };
  await waitFor(()=>secondPid()===second.pid && fs.existsSync(b));
  await terminate(second);
  assert.equal(fs.existsSync(path.join(b,"local_locked.json")),false);
  assert.equal(synced(),false,"채우기 전에 디스크에서 삭제 기준을 해제했다");
  const finished = new Promise(resolve=>holder.once("exit",resolve));
  fs.writeFileSync(flag("finish"),"");
  await finished;
  assert.equal(run("--once").status,0);
  for (const dir of [a,b]) for (const n of names) assert.equal(fs.readFileSync(path.join(dir,n),"utf8"),'{"keep":true}');
});

test("표준 설치 파일만 저장된 데이터 경로를 사용하고 환경 변수를 우선한다", {
  skip: !process.env.CLAUDE_SESSION_SHARE_TEST_EXE
}, () => {
  const root=path.join(testRoot,"installed");
  const env={...sandboxEnv, HOME:root, USERPROFILE:root, LOCALAPPDATA:path.join(root,"local"), APPDATA:path.join(root,"roaming")};
  const standard=path.join(env.LOCALAPPDATA,"claude-session-share");
  const custom=path.join(root,"custom");
  const installed=path.join(standard,"claude-session-share.exe");
  fs.mkdirSync(standard,{recursive:true});
  fs.copyFileSync(command,installed);
  fs.writeFileSync(path.join(standard,"runtime-home.txt"),custom+"\r\n");
  const dataPath=(exe,vars)=>{
    const result=spawnSync(exe,["--help"],{env:vars, encoding:"utf8", windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    return result.stdout.trim().split("\n").at(-1).replace(/^데이터 폴더: /,"");
  };
  assert.equal(dataPath(command,env),standard);
  assert.equal(dataPath(installed,env),custom);
  assert.equal(dataPath(installed,{...env,CLAUDE_SESSION_SHARE_HOME:root}),root);
});

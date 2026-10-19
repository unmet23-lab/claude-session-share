// claude-session-share — Claude 데스크톱(Windows) Code 탭에서 어느 계정으로 로그인해도 세션 목록이 그대로 보이게 한다.
// Keeps the Claude desktop (Windows) Code-tab session list identical across every account you sign in with.
// https://github.com/unmet23-lab/claude-session-share (MIT) — 비공식 도구, Anthropic과 무관.
//
// 앱은 세션 목록을 <앱 데이터>\claude-code-sessions\<계정ID>\<조직ID>\ 에 계정·조직 짝마다 따로 둔다
// (세션 기록 local_*.json, 삭제 표식 deleted_*, 보관 색인 archived-sessions.idx, 예약 작업 scheduled-tasks.json, backlog\).
// 짝 폴더를 junction(연결 폴더)으로 묶으면 앱이 쓰기를 거부한다 — main.log 「Refusing non-directory at private dir path (symlink/file plant)」,
// 앱이 lstat·realpath로 reparse point를 막기 때문이다. 그래서 연결은 전혀 쓰지 않는다:
//   - 모든 짝 폴더를 실제 폴더로 두고(남은 junction은 실제 폴더로 바꾼다), 어느 한 폴더의 변화(추가·수정·삭제)를 나머지 전부에 옮긴다.
//   - 같은 파일이 폴더마다 다르면 더 최근(mtime) 것이 이긴다. 삭제는 「지난번엔 있었는데 없어진」 폴더에서만 읽어 전파한다.
//   - 세션 기록(local_*.json)은 삭제 표식(deleted_<CLI 세션ID>)이 어디든 있으면 지운 것으로 보고 되살리지 않는다.
//   - 예약 작업 목록(scheduled-tasks.json)만은 파일째 맞추지 않고 작업(id)마다 합친다. 앱은 로그인할 때마다 목록을 다시 쓰고
//     처음 보는 짝엔 빈 목록을 써서, 「최근 것이 이김」이면 그 빈 목록이 모든 계정의 예약을 지운다(아래 「예약 작업 목록」).
//   - 앱이 처음 보는 짝으로 로그인하면(main.log 「Loaded 0 persisted sessions from …」) 그 폴더를 바로 채우고 윈도 알림으로 「껐다 켜기」를 알린다.
//     같은 계정으로 다시 로그인할 때도 「Loaded 0」이 남지만(직전 줄 existingSessions=N, 이미 메모리에 있어 새로 읽은 게 없다는 뜻) 그때는 알리지 않는다.
//   - 대화 원문(~/.claude/projects)은 계정과 상관없이 하나라 손대지 않는다.
//   - --once --backup은 맞추기 전에 모든 짝 폴더를 통째로 백업한다. 지켜보는 동안엔 가장 기록이 많은 폴더를 매시간 백업한다(최근 24개).
// 상태·기록·pid·백업은 %LOCALAPPDATA%\claude-session-share\ 에 둔다(환경 변수 CLAUDE_SESSION_SHARE_HOME으로 바꿀 수 있다).
// 실행: node claude-session-share.mjs                  계속 지켜보기(시작프로그램 claude-session-share.vbs가 띄운다)
//       node claude-session-share.mjs --once           한 번 맞추고 끝(--backup을 붙이면 먼저 전체 백업)
//       node claude-session-share.mjs --status         상태만 보기
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const ROAMING = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
// 이 도구의 상태·기록·pid·백업 자리. 스크립트를 어디서 실행하든 같은 곳을 쓴다.
const DATA_DIR = process.env.CLAUDE_SESSION_SHARE_HOME || path.join(LOCAL, "claude-session-share");
const STATE_PATH = path.join(DATA_DIR, "claude-session-share.json");
const LOG_PATH = path.join(DATA_DIR, "claude-session-share.log");
const PID_PATH = path.join(DATA_DIR, "claude-session-share.pid");
const BACKUP_DIR = path.join(DATA_DIR, "claude-session-backups");
const TREES = ["claude-code-sessions", "local-agent-mode-sessions"];
const POLL_MS = 1000;
const WATCH_DEBOUNCE_MS = 150;
const FULL_SCAN_MS = 5 * 60000;
const CONFIG_SCAN_MS = 60000;
const SNAPSHOT_MS = 3600000;
const SNAPSHOT_KEEP = 24;
const STATE_WRITE_DEBOUNCE_MS = 2000;
const LOG_FIRST_READ_MAX = 8 * 1024 * 1024;
const LOG_FILE_MAX = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// existingSessions는 로그인 때 앱 메모리에 이미 있던 세션 수다(같은 계정 재로그인이면 0보다 크다). 옛 앱 판에는 없을 수 있다.
const INIT_LINE = /\[LocalSessionManager\] Initialization succeeded — accountId=([0-9a-f-]{36}), orgId=([0-9a-f-]{36})(?:, existingSessions=(\d+))?/g;
// 경로에 공백이 있어도 되게(C:\Users\Hong Gildong\…) 「.+?」로 줄 안에서만 찾는다. 「.」은 줄을 넘지 않는다.
const LOADED_LINE = /Loaded (\d+) persisted sessions from (.+?)[\\/]([0-9a-f-]{36})[\\/]([0-9a-f-]{36})(?=\s|$)/g;
const LOGOUT_LINE = /\[LocalSessionManager\] Account logged out/g;
// 앱이 쓰다 만 임시 파일(.tmp-<pid>-<uuid>, 이름.tmp-숫자10자리hex6자리, 이름.json.tmp)과 우리 임시 파일(.mirror-…)은 건너뛴다.
// 이름.json.tmp는 앱이 쓰고 곧바로 이름을 바꾸는 파일이라, 옮기려 하면 「복사 실패: ENOENT」만 남는다(2026-10-18 기록 202줄).
const isTempName = (n) => n.startsWith(".") || /\.tmp-\d{10}[a-f0-9]{6}$/.test(n) || /\.tmp$/i.test(n);
// 짝 폴더 맨 위의 예약 작업 목록. 파일 미러에서 빼고 syncRegistry가 작업마다 합친다.
const REGISTRY = "scheduled-tasks.json";
const RESTORE_NOTE_MS = 3600000;

const tryJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const safeReaddir = (p) => { try { return fs.readdirSync(p); } catch { return []; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const pad = (n) => String(n).padStart(2, "0");
const hourStamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}`;
const secStamp = (d = new Date()) => `${hourStamp(d)}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const pairKey = (acct, org) => `${acct.toLowerCase()}/${org.toLowerCase()}`;
const short = (key) => key.split("/").map((s) => s.slice(0, 8)).join("/");
const lower = (p) => path.resolve(p).toLowerCase();

function kind(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
  } catch { return null; }
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_FILE_MAX) {
      const text = fs.readFileSync(LOG_PATH, "utf8");
      fs.writeFileSync(LOG_PATH, text.slice(text.length / 2));
    }
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
  if (process.stdout.isTTY) process.stdout.write(line);
}

/* ---------- 윈도 알림 ---------- */
// 발신자는 Windows PowerShell이다. 아래 {1AC14E77-…} GUID는 Windows 시스템 폴더(FOLDERID_System)를 뜻하는 고정값이다(계정 ID 아님).
// 굵은 제목 + 본문 한두 줄. 본문이 잘리지 않고 감기게 ToastGeneric으로 그린다(제목 2줄·본문 합쳐 4줄까지).
// 줄 수만큼 글자 칸이 있는 옛 틀(ToastText02·ToastText04)로 XML을 받은 뒤 틀 이름만 ToastGeneric으로 바꾼다.
// CLAUDE_SESSION_SHARE_NOTIFY_FILE이 있으면 알림 대신 그 파일에 적는다(시험용).
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const PS_EXE = path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function notify(title, ...lines) {
  if (process.env.CLAUDE_SESSION_SHARE_NOTIFY_FILE) {
    try { fs.appendFileSync(process.env.CLAUDE_SESSION_SHARE_NOTIFY_FILE, [title, ...lines].join(" | ") + "\n"); } catch {}
    return;
  }
  const texts = [title, ...lines.slice(0, 2)].map((s, i) => `$null = $t.Item(${i}).AppendChild($x.CreateTextNode(${psq(s)}))`).join("\n");
  const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::${lines.length > 1 ? "ToastText04" : "ToastText02"})
$x.GetElementsByTagName('binding').Item(0).SetAttribute('template', 'ToastGeneric')
$t = $x.GetElementsByTagName('text')
${texts}
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  // detached로 띄우면 Windows가 콘솔을 주지 않아 PowerShell이 한 줄도 돌지 않고 끝난다(2026-10-19 확인, 그전 판은 알림이 뜨지 않았다).
  // 그래서 떼지 않고 숨김으로 띄운다. 떼지 않은 자식은 node가 끝나면 함께 끝나므로 unref하지 않는다(--once도 알림이 끝날 때까지 기다린다).
  // 혹시 멈춰도 --once·설치기가 붙잡히지 않게 30초에서 끊는다.
  try {
    const child = spawn(PS_EXE, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")],
      { windowsHide: true, stdio: "ignore", timeout: 30000 });
    child.on("error", (e) => log(`알림을 띄우지 못함: ${e.message}`));
    child.on("exit", (code, signal) => { if (code || signal) log(`알림 PowerShell이 ${signal || `종료 코드 ${code}`}로 끝남`); });
  } catch (e) { log(`알림을 띄우지 못함: ${e.message}`); }
}

/* ---------- 앱 위치 ---------- */
// 앱 데이터 뿌리. MSIX 설치는 %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude, 아니면 %APPDATA%\Claude.
// 2026-10-19부터 스토어 앱이 데이터를 패키지 밖 %LOCALAPPDATA%\Claude-Data\<패키지 이름 소문자>로 통째로 옮긴다
// (main.log 「[user-data-move] moved」, 옛 자리엔 .user-data-left.<이름> 표식만 남는다). 계정마다 켜고 끄는 설정이라
// 다시 패키지 안으로 돌아갈 수도 있다. 세션 폴더는 한 번에 한 곳에만 있으니 세션 폴더가 있는 쪽을 뿌리로 센다.
// 두 곳에 다 있으면 떠났다는 표식이 있는 패키지 안 사본은 앱이 쓰지 않는 것이라 뺀다(채워서 「두 곳 다 있음」을 만들지 않게).
const familyOf = (d) => {
  const parts = path.resolve(d).split(path.sep);
  const i = parts.findIndex((p) => /^Claude_/i.test(p));
  return i < 0 ? null : parts[i].toLowerCase();
};
const leftMarker = (d) => safeReaddir(d).some((n) => /^\.user-data-left\./i.test(n));
function findRoots() {
  const cands = [];
  const pk = path.join(LOCAL, "Packages");
  for (const name of safeReaddir(pk)) if (/^Claude_/i.test(name)) cands.push(path.join(pk, name, "LocalCache", "Roaming", "Claude"));
  const outside = path.join(LOCAL, "Claude-Data");
  for (const name of safeReaddir(outside)) if (/^Claude_/i.test(name)) cands.push(path.join(outside, name));
  cands.push(path.join(ROAMING, "Claude"));
  // 스토어 앱 안의 터미널에서 실행되면 %APPDATA%\Claude가 패키지 폴더로 돌려져 같은 폴더가 두 번 보인다. 실제 위치로 한 번만 센다.
  const seen = new Set();
  const found = cands.filter((d) => TREES.some((t) => kind(path.join(d, t)) === "dir")).filter((d) => {
    let real = d;
    try { real = fs.realpathSync.native(d); } catch {}
    if (seen.has(lower(real))) return false;
    seen.add(lower(real));
    return true;
  });
  const moved = new Set(found.filter((d) => lower(path.dirname(d)) === lower(outside)).map(familyOf));
  return found.filter((d) => !(lower(path.dirname(d)) !== lower(outside) && moved.has(familyOf(d)) && leftMarker(d)));
}

// Claude·Codex 같은 스토어 앱 안의 터미널에서 실행되면 AppData 쓰기가 그 앱 전용 폴더(Packages\<앱>\LocalCache)로 돌려진다.
// 그러면 상태·pid가 따로 생겨 지켜보기가 둘이 될 수 있다. 탐침 파일을 써 보고 돌려졌으면 그 앱 폴더 이름을 돌려준다.
function redirectedTo() {
  const name = `.claude-session-share-probe-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  const probe = path.join(LOCAL, name);
  try { fs.writeFileSync(probe, ""); } catch { return null; }
  try {
    for (const pkg of safeReaddir(path.join(LOCAL, "Packages"))) if (fs.existsSync(path.join(LOCAL, "Packages", pkg, "LocalCache", "Local", name))) return pkg;
    return null;
  } finally { try { fs.unlinkSync(probe); } catch {} }
}
const BOXED_MSG = (pkg) => `이 창은 ${pkg.split("_")[0]} 같은 앱 안에서 연 터미널이라 여기서는 제대로 돌지 않습니다(이런 창에서는 AppData 파일이 그 앱 전용 폴더로 돌려집니다). 시작 단추 → powershell 입력 → Enter로 PowerShell을 따로 열어 다시 실행하세요.`;

function findMainLog() {
  const cands = [path.join(LOCAL, "Claude", "logs", "main.log"), path.join(ROAMING, "Claude", "logs", "main.log")];
  for (const r of findRoots()) cands.push(path.join(r, "logs", "main.log"));
  const found = cands.filter((p) => fs.existsSync(p));
  found.sort((a, b) => mtime(b) - mtime(a));
  return found[0] || null;
}

/* ---------- 계정 짝 찾기 ---------- */
// 로그에서 새로 나온 줄을 읽어 로그인 짝·「Loaded N persisted sessions」·로그아웃을 모은다.
function readLogEvents(state, logPath) {
  const out = { inits: [], loaded: [], logout: false };
  if (!logPath) return out;
  let size;
  try { size = fs.statSync(logPath).size; } catch { return out; }
  if (state.logPath !== logPath || size < (state.logOffset || 0)) { state.logPath = logPath; state.logOffset = 0; }
  if (size === state.logOffset) return out;
  const start = Math.max(state.logOffset, size - LOG_FIRST_READ_MAX);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(logPath, "r");
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return out;
  state.logOffset = start + lastNl + 1;
  const text = buf.subarray(0, lastNl).toString("utf8");
  // 시간 순서를 지키려고 세 가지를 위치와 함께 모은다.
  const ev = [];
  for (const m of text.matchAll(INIT_LINE)) ev.push({ at: m.index, type: "init", key: pairKey(m[1], m[2]), existing: m[3] === undefined ? null : Number(m[3]) });
  for (const m of text.matchAll(LOADED_LINE)) if (UUID.test(m[3]) && UUID.test(m[4])) ev.push({ at: m.index, type: "loaded", n: Number(m[1]), tree: path.basename(m[2]), key: pairKey(m[3], m[4]) });
  for (const m of text.matchAll(LOGOUT_LINE)) ev.push({ at: m.index, type: "logout" });
  ev.sort((a, b) => a.at - b.at);
  // 「Loaded N」 줄에는 그 짝의 바로 앞 로그인 줄의 existingSessions를 붙인다. 두 줄이 다른 바퀴에 읽혀도 되게 상태에 둔다.
  const existing = (state.existing ||= {});
  for (const e of ev) {
    if (e.type === "init") { out.inits.push(e.key); out.logout = false; existing[e.key] = e.existing; }
    else if (e.type === "loaded") out.loaded.push({ ...e, existing: existing[e.key] ?? null });
    else out.logout = true;
  }
  return out;
}

// 터미널 claude 로그인 파일에서도 짝을 안다(앱에서 아직 로그인하지 않은 계정의 폴더를 미리 채워 둔다).
// 기본은 ~/.claude.json. CLAUDE_CONFIG_DIR, 그리고 CLAUDE_SESSION_SHARE_CONFIG_DIRS(; 로 구분한 폴더들)의 .claude.json도 읽는다.
function pairsFromConfigs() {
  const files = [path.join(HOME, ".claude.json"), path.join(HOME, ".claude", ".claude.json")];
  const extra = [process.env.CLAUDE_CONFIG_DIR, ...(process.env.CLAUDE_SESSION_SHARE_CONFIG_DIRS || "").split(";")];
  for (const d of extra) if (d && d.trim()) files.push(path.join(d.trim(), ".claude.json"));
  const out = [];
  for (const f of files) {
    const a = tryJson(f)?.oauthAccount;
    if (a && UUID.test(a.accountUuid || "") && UUID.test(a.organizationUuid || "")) out.push(pairKey(a.accountUuid, a.organizationUuid));
  }
  return out;
}

function pairsFromDirs(treeDir) {
  const out = [];
  for (const acct of safeReaddir(treeDir)) {
    if (!UUID.test(acct)) continue;
    for (const org of safeReaddir(path.join(treeDir, acct))) if (UUID.test(org)) out.push(pairKey(acct, org));
  }
  return out;
}

const countRecords = (dir) => safeReaddir(dir).filter((n) => n.startsWith("local_") && n.endsWith(".json")).length;

/* ---------- 폴더 훑기·복사 ---------- */
// dir 안의 파일을 상대 경로('/' 구분) → {m: mtime, s: 크기}로 모은다. 하위 폴더도 본다. 연결은 들어가지 않는다.
// 삭제 표식(deleted_*)은 한 번 쓰이면 안 바뀌는 13바이트 파일이 수천 개라, 지난번에 본 것은 stat을 건너뛴다.
function scanDir(dir, prev) {
  const out = new Map();
  const walk = (d, rel) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (isTempName(e.name) || e.isSymbolicLink()) continue;
      if (!rel && e.name === REGISTRY) continue; // 예약 작업 목록은 syncRegistry가 맡는다
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(p, r); continue; }
      if (!e.isFile()) continue;
      const known = prev?.get(r);
      if (known && e.name.startsWith("deleted_")) { out.set(r, known); continue; }
      // mtime은 ms로 반올림해 비교한다(복사본에 ms 단위로 찍은 시각과 원본의 100ns 단위 시각이 어긋나 다시 복사하는 일 방지).
      try { const st = fs.statSync(p); out.set(r, { m: Math.round(st.mtimeMs), s: st.size }); } catch {}
    }
  };
  walk(dir, "");
  return out;
}

// 같은 내용을 원본과 같은 mtime으로 복사한다(임시 파일에 쓴 뒤 이름 바꾸기).
// pair: 받는 짝 폴더. 그 안의 하위 폴더(backlog\ 등)만 만들고 짝 폴더 자체는 만들지 않는다 — 앱이 데이터를 통째로 다른 자리로
// 옮긴 직후 옛 경로에 쓰면 옛 자리에 세션 폴더가 되살아나 「두 곳 다 있음」이 된다(2026-10-19 Claude-Data 옮김).
function copyFile(src, dst, st, pair) {
  if (pair && kind(pair) !== "dir") throw Object.assign(new Error("받는 짝 폴더가 없어짐(앱이 데이터를 옮겼을 수 있음)"), { code: "ENOENT" });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = path.join(path.dirname(dst), `.mirror-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  const t = new Date(st.m);
  try { fs.utimesSync(dst, t, t); } catch {}
}

const newer = (a, b) => !b || a.m > b.m || (a.m === b.m && a.s !== b.s);

/* ---------- 미러 ---------- */
// ctx.manifests[tree]: Map(dir → Map(rel → {m,s}))  지난번 맞춘 뒤 각 폴더가 가진 것
// state.union[tree]: {rel → {m,s}}                  지난번 맞춘 뒤 모든 폴더가 똑같이 가진 것(재시작해도 삭제를 알아보려고 저장)
// state.synced[tree]: [dir…]                        지난번에 union과 같게 맞춰 둔 폴더(재시작 뒤 이 폴더에서 없어진 파일은 삭제로 본다)
function syncTree(ctx, tree, opts = {}) {
  const { state } = ctx;
  const manifests = (ctx.manifests[tree] ||= new Map());
  // 짝 폴더가 통째로 없어졌으면(앱이 데이터를 다른 자리로 옮김) 「안의 파일을 다 지웠다」로 읽지 않는다 — 비어 있는 것과 없는 것은 다르다.
  // 그렇게 읽으면 그 폴더에 있던 기록을 다른 계정 폴더에서도 지운다. 없는 폴더는 빼고 다음 바퀴에 뿌리를 다시 찾는다.
  const all = ctx.family[tree] || [];
  const dirs = all.filter((d) => kind(d) === "dir");
  if (dirs.length < all.length) {
    ctx.rootsMoved = true;
    for (const d of all) if (!dirs.includes(d)) { manifests.delete(d); ctx.dirty.delete(lower(d)); }
    log(`${tree}: 짝 폴더 ${all.length - dirs.length}곳이 없어짐 — 지운 것으로 치지 않고 앱 데이터 자리를 다시 찾음`);
  }
  if (dirs.length === 0) return { copied: 0, removed: 0 };
  const union = (state.union[tree] ||= {});
  const syncedBefore = new Set((state.synced[tree] || []).map(lower));
  const dirtyAll = opts.full || !ctx.fullScanned[tree];
  const toScan = dirs.filter((d) => dirtyAll || ctx.dirty.has(lower(d)));
  if (toScan.length === 0) return { copied: 0, removed: 0 };
  const scans = new Map();
  for (const d of toScan) scans.set(d, scanDir(d, manifests.get(d)));

  const upserts = new Map(); // rel → {m, s, src}
  const deletes = new Set();
  for (const [d, scan] of scans) {
    const prev = manifests.get(d) || (syncedBefore.has(lower(d)) ? new Map(Object.entries(union)) : null);
    for (const [rel, st] of scan) {
      const known = prev?.get(rel) || union[rel];
      if (newer(st, known) || (!known && !upserts.has(rel))) {
        const cur = upserts.get(rel);
        if (!cur || st.m > cur.m) upserts.set(rel, { ...st, src: d });
      }
    }
    if (prev) for (const rel of prev.keys()) if (!scan.has(rel)) deletes.add(rel);
  }
  // 어떤 폴더엔 있고 다른 폴더엔 없는 파일(전엔 못 봤던 폴더 포함)을 채운다. union에만 있고 모든 폴더에서 사라진 건 지운 것.
  if (dirtyAll) {
    const seen = new Map();
    for (const [, scan] of scans) for (const [rel, st] of scan) { const c = seen.get(rel); if (!c || st.m > c.m) seen.set(rel, st); }
    for (const [rel, st] of seen) {
      if (deletes.has(rel) && !upserts.has(rel)) continue;
      const incomplete = [...scans.values()].some((s) => newer(st, s.get(rel)));
      if (incomplete && !upserts.has(rel)) {
        let src = null;
        for (const [d, s] of scans) { const v = s.get(rel); if (v && !newer(st, v)) { src = d; break; } }
        if (src) upserts.set(rel, { ...st, src });
      }
    }
  }
  for (const rel of upserts.keys()) deletes.delete(rel);

  // 세션 기록은 삭제 표식이 어디든 있으면 되살리지 않는다(앱이 지운 세션을 다른 폴더의 옛 사본이 되살리는 일 방지).
  if (tree === "claude-code-sessions") {
    const tombs = new Set();
    for (const [, scan] of scans) for (const rel of scan.keys()) if (rel.startsWith("deleted_")) tombs.add(rel.slice("deleted_".length));
    for (const rel of Object.keys(union)) if (rel.startsWith("deleted_")) tombs.add(rel.slice("deleted_".length));
    for (const [rel, u] of [...upserts]) {
      if (!/^local_[^/]+\.json$/.test(rel)) continue;
      const cli = tryJson(path.join(u.src, rel))?.cliSessionId;
      if (cli && tombs.has(cli)) { upserts.delete(rel); deletes.add(rel); log(`${rel} — 삭제 표식(deleted_${cli.slice(0, 8)})이 있어 되살리지 않고 지움`); }
    }
  }

  let copied = 0, removed = 0, failed = 0;
  for (const [rel, u] of upserts) {
    const src = path.join(u.src, rel);
    for (const d of dirs) {
      if (d === u.src) continue;
      const cur = (scans.get(d) || manifests.get(d))?.get(rel) || (scans.has(d) || manifests.has(d) ? null : union[rel]);
      if (!newer(u, cur)) continue;
      try { copyFile(src, path.join(d, rel), u, d); copied++; }
      catch (e) { failed++; ctx.dirty.add(lower(u.src)); if (kind(d) !== "dir") ctx.rootsMoved = true; log(`${path.basename(path.dirname(d))}/${short(path.basename(d))} ← ${rel} 복사 실패: ${e.code || ""} ${e.message}`); continue; }
      (scans.get(d) || manifests.get(d))?.set(rel, { m: u.m, s: u.s });
      ctx.dirMtimes?.set(lower(d), mtime(d)); // 우리가 쓴 것 때문에 폴더 mtime 감시가 다시 훑지 않게
    }
    union[rel] = { m: u.m, s: u.s };
    (scans.get(u.src) || manifests.get(u.src))?.set(rel, { m: u.m, s: u.s });
  }
  for (const rel of deletes) {
    if (rel === REGISTRY) { delete union[rel]; continue; } // 옛 상태에 남은 목록 줄 때문에 파일을 지우지 않는다
    for (const d of dirs) {
      const p = path.join(d, rel);
      if (kind(p) !== "file") continue;
      try { fs.unlinkSync(p); removed++; } catch (e) { failed++; log(`${rel} 삭제 실패(${short(path.basename(d))}): ${e.code || ""} ${e.message}`); continue; }
      (scans.get(d) || manifests.get(d))?.delete(rel);
      ctx.dirMtimes?.set(lower(d), mtime(d));
    }
    delete union[rel];
  }
  for (const [d, scan] of scans) { manifests.set(d, scan); ctx.dirty.delete(lower(d)); }
  if (dirtyAll && failed === 0) { ctx.fullScanned[tree] = true; state.synced[tree] = dirs.slice(); }
  else if (failed === 0) state.synced[tree] = [...new Set([...(state.synced[tree] || []), ...dirs])];
  if (copied || removed || failed) {
    // 바뀐 파일이 몇 개뿐이면 이름도 남긴다(어떤 세션이 사라졌는지 나중에 찾을 수 있게).
    const names = [...upserts.keys()].map((r) => `+${r}`).concat([...deletes].map((r) => `-${r}`));
    log(`${tree}: ${toScan.length}곳 확인, ${copied}개 복사, ${removed}개 삭제${failed ? `, ${failed}개 실패(다시 시도)` : ""}${names.length && names.length <= 5 ? ` [${names.join(" ")}]` : ""}`);
  }
  ctx.stateDirty = true;
  return { copied, removed };
}

/* ---------- 예약 작업 목록 ---------- */
// scheduled-tasks.json은 파일째 「최근 것이 이김」으로 맞추지 않는다. 앱은 로그인할 때마다 그 짝의 목록을 다시 쓰고,
// 처음 로그인한 짝에는 빈 목록을 새로 쓴다. 그 빈 파일이 가장 최근이 되면 모든 계정의 예약이 지워진다(2026-10-17에 겪음).
// 그래서 작업(id) 단위로 합친다.
//   - 어느 폴더에든 새로 생긴 작업은 모두에 더한다. 같은 작업이 폴더마다 다르면 더 최근에 바뀐 파일의 것으로 맞춘다.
//   - 작업이 빠진 것은 「앱이 그 짝에 로그인할 때 읽었거나 그 짝에서 만든 작업」이 하나 빠졌을 때만 지운 것으로 본다.
//     처음 로그인한 짝의 빈 목록, 미러가 나중에 넣어 줘서 앱이 아직 모르는 작업, 한 번에 둘 이상 빠진 것은 지우지 않고 되살린다.
//   - 나머지 칸은 가장 최근 파일을 바탕으로 하고, recordedSkips는 모든 폴더 것을 합친다.
// state.tasks[tree] = { union: {id → {r: 작업, m: 그 판이 나온 파일 시각}}, order: [id…], known: {짝 → [id…]}, dirs: {폴더 → {m, s, ids}} }
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const dirPair = (d) => pairKey(path.basename(path.dirname(d)), path.basename(d));

function readRegistry(d) {
  const p = path.join(d, REGISTRY);
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  const head = { m: Math.round(st.mtimeMs), s: st.size };
  const j = tryJson(p);
  if (!j || typeof j !== "object" || !Array.isArray(j.scheduledTasks)) return { ...head, bad: true };
  return { ...head, j, ids: j.scheduledTasks.map((t) => t && t.id).filter(Boolean) };
}

function writeRegistry(d, text) {
  const tmp = path.join(d, `.mirror-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path.join(d, REGISTRY));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function syncRegistry(ctx, tree, inits = []) {
  const { state } = ctx;
  const dirs = ctx.family[tree] || [];
  if (dirs.length === 0) return;
  const all = (state.tasks ||= {});
  const fresh = !all[tree];
  const R = (all[tree] ||= { union: {}, order: [], known: {}, dirs: {} });
  const now = new Map();
  for (const d of dirs) now.set(d, readRegistry(d));
  const dirOf = (key) => dirs.find((x) => dirPair(x) === key);

  // 처음 켤 때는 지금 계정의 앱이 자기 폴더 목록을 읽었다고 본다.
  if (fresh && state.active) { const cur = now.get(dirOf(state.active)); if (cur?.ids) R.known[state.active] = cur.ids.slice(); }
  // 로그인: 앱이 그 짝의 목록을 읽었다. 그때 파일에 있던 작업만 앱이 안다(처음 보는 짝이면 하나도 모른다).
  for (const key of inits) { const cur = now.get(dirOf(key)); R.known[key] = cur?.ids ? cur.ids.slice() : []; }

  const changed = dirs.filter((d) => {
    const cur = now.get(d), prev = R.dirs[lower(d)];
    return cur && !cur.bad && !(prev && prev.m === cur.m && prev.s === cur.s);
  }).sort((a, b) => now.get(a).m - now.get(b).m);
  if (!changed.length && !inits.length && dirs.every((d) => now.get(d))) return;

  const restored = new Map(); // 짝 → 되살린 id들
  for (const d of changed) {
    const cur = now.get(d), key = dirPair(d), prev = R.dirs[lower(d)];
    for (const t of cur.j.scheduledTasks) {
      if (!t || !t.id) continue;
      const u = R.union[t.id];
      if (!u) {
        R.union[t.id] = { r: t, m: cur.m };
        if (!R.order.includes(t.id)) R.order.push(t.id);
        if (key === state.active && !(R.known[key] ||= []).includes(t.id)) R.known[key].push(t.id);
        log(`${tree} 예약 작업 +${t.id} (${short(key)})`);
      } else if (cur.m >= u.m && stable(u.r) !== stable(t)) {
        R.union[t.id] = { r: t, m: cur.m };
      }
    }
    if (prev?.ids) {
      const gone = prev.ids.filter((id) => R.union[id] && !cur.ids.includes(id));
      const known = R.known[key];
      const real = known ? gone.filter((id) => known.includes(id)) : gone;
      if (real.length === 1) {
        const id = real[0];
        delete R.union[id];
        R.order = R.order.filter((x) => x !== id);
        for (const k of Object.keys(R.known)) R.known[k] = R.known[k].filter((x) => x !== id);
        log(`${tree} 예약 작업 -${id} (${short(key)}에서 지움)`);
      }
      const kept = gone.filter((id) => R.union[id]);
      if (kept.length) {
        restored.set(key, kept);
        const why = real.length > 1 ? `한 번에 ${real.length}개가 빠짐` : "앱이 모르는 작업";
        const msg = `${tree} 예약 작업 ${kept.length}개가 ${short(key)}에서 빠졌지만 지우지 않고 되살림(${why}): ${kept.join(", ")}`;
        if (ctx.lastRestoreMsg !== msg) { log(msg); ctx.lastRestoreMsg = msg; }
      }
    }
    R.dirs[lower(d)] = { m: cur.m, s: cur.s, ids: cur.ids.slice() };
  }

  // 맞출 판: 가장 최근 파일을 바탕으로, 작업 목록은 합친 것, recordedSkips는 모두 합친 것.
  const valid = dirs.map((d) => now.get(d)).filter((c) => c && !c.bad).sort((a, b) => a.m - b.m);
  const want = valid.length ? { ...valid[valid.length - 1].j } : { scheduledTasks: [], recordedSkips: {} };
  const skips = {};
  for (const c of valid) if (c.j.recordedSkips && typeof c.j.recordedSkips === "object") Object.assign(skips, c.j.recordedSkips);
  want.scheduledTasks = R.order.filter((id) => R.union[id]).map((id) => R.union[id].r);
  if ("recordedSkips" in want || Object.keys(skips).length) want.recordedSkips = skips;
  const wantKey = stable(want), text = JSON.stringify(want, null, 2), ids = want.scheduledTasks.map((t) => t.id);
  let wrote = 0;
  for (const d of dirs) {
    const cur = now.get(d);
    if (cur?.bad) continue; // 앱이 쓰는 중일 수 있다. 다음 바퀴에 다시 본다.
    if (cur && stable(cur.j) === wantKey) continue;
    try {
      writeRegistry(d, text);
      const st = fs.statSync(path.join(d, REGISTRY));
      R.dirs[lower(d)] = { m: Math.round(st.mtimeMs), s: st.size, ids: ids.slice() };
      ctx.dirMtimes?.set(lower(d), mtime(d));
      wrote++;
    } catch (e) { log(`${tree} 예약 목록 쓰기 실패(${short(dirPair(d))}): ${e.code || ""} ${e.message}`); }
  }
  if (wrote) log(`${tree} 예약 목록을 ${ids.length}개(${ids.join(", ") || "없음"})로 ${wrote}곳 맞춤`);
  // 지금 계정의 앱은 되살린 작업을 아직 모른다(메모리의 목록으로 돌린다). 껐다 켜야 다시 돈다.
  const mine = restored.get(state.active);
  if (mine && ctx.daemon && Date.now() - (ctx.lastRestoreNote || 0) >= RESTORE_NOTE_MS) {
    ctx.lastRestoreNote = Date.now();
    notify("Claude 세션 공유", `예약 작업 ${mine.length}개가 이 계정 목록에서 빠져 다시 넣었어요. Claude를 한 번 껐다 켜면 다시 돌아요.`);
  }
  ctx.stateDirty = true;
}

/* ---------- 짝 폴더 준비 ---------- */
// 짝 폴더가 연결이면 실제 폴더로 바꾸고(가리키던 폴더는 그대로), 없으면 만든다. 파일이 자리에 있으면 건너뛴다.
function ensureRealDir(p) {
  const k = kind(p);
  if (k === "dir") return true;
  if (k === "file") { log(`${p} 자리에 파일이 있어 건너뜀`); return false; }
  if (k === "link") {
    let target = "?";
    try { target = fs.readlinkSync(p); } catch {}
    fs.rmdirSync(p);
    log(`${path.basename(path.dirname(p)).slice(0, 8)}/${path.basename(p).slice(0, 8)} 연결(→ ${target})을 걷어내고 실제 폴더로 바꿈`);
  }
  // 트리 폴더(…\claude-code-sessions)가 없으면 만들지 않는다 — 앱이 데이터를 막 다른 자리로 옮긴 참이면 옛 자리를 되살리게 된다.
  if (kind(path.dirname(path.dirname(p))) !== "dir") return false;
  fs.mkdirSync(p, { recursive: true });
  return true;
}

function refreshFamily(ctx) {
  const { state } = ctx;
  const roots = findRoots();
  if (roots.length === 0) return;
  // 기록이 가장 많은 뿌리를 주된 뿌리로 본다(앱이 쓰는 곳). 알려진 짝 폴더는 거기에만 만든다.
  let primary = roots[0], best = -1;
  for (const r of roots) {
    let n = 0;
    for (const key of pairsFromDirs(path.join(r, "claude-code-sessions"))) n += countRecords(path.join(r, "claude-code-sessions", ...key.split("/")));
    if (n > best) { best = n; primary = r; }
  }
  ctx.primary = primary;
  ctx.family = {};
  for (const tree of TREES) {
    const dirs = [];
    const keys = new Set();
    for (const r of roots) for (const key of pairsFromDirs(path.join(r, tree))) { keys.add(key); dirs.push(path.join(r, tree, ...key.split("/"))); }
    for (const key of Object.keys(state.known)) if (!keys.has(key) && kind(path.join(primary, tree)) === "dir") dirs.push(path.join(primary, tree, ...key.split("/")));
    const ok = [];
    for (const d of dirs) {
      try {
        const existed = kind(d) === "dir";
        if (!ensureRealDir(d)) continue;
        ok.push(d);
        // 새로 만든(다시 만든) 빈 폴더는 「지난번에 맞춘 폴더」로 치지 않는다. 비어 있다고 「다 지웠다」로 읽으면
        // 그 폴더에 있던 기록을 다른 계정 폴더에서도 지운다. 처음 보는 폴더처럼 다른 폴더의 기록으로 채운다.
        if (!existed && (state.synced[tree] || []).some((s) => lower(s) === lower(d))) {
          state.synced[tree] = state.synced[tree].filter((s) => lower(s) !== lower(d));
          ctx.manifests[tree]?.delete(d);
          ctx.stateDirty = true;
          log(`${short(path.basename(path.dirname(d)) + "/" + path.basename(d))}: 사라졌던 짝 폴더를 다시 만듦 — 지운 것으로 치지 않고 채움`);
        }
      } catch (e) { log(`${d} 준비 실패: ${e.code || ""} ${e.message}`); }
    }
    ok.sort();
    const before = (ctx.family[tree] || ctx.lastFamily?.[tree] || []).map(lower).join("|");
    ctx.family[tree] = ok;
    if (ok.map(lower).join("|") !== before) { ctx.fullScanned[tree] = false; resetWatchers(ctx, tree); }
  }
  ctx.lastFamily = ctx.family;
}

function resetWatchers(ctx, tree) {
  for (const w of ctx.watchers[tree] || []) { try { w.close(); } catch {} }
  ctx.watchers[tree] = [];
  if (!ctx.daemon) return;
  for (const d of ctx.family[tree]) {
    try {
      const w = fs.watch(d, { recursive: true }, () => { ctx.dirty.add(lower(d)); scheduleTick(ctx, WATCH_DEBOUNCE_MS); });
      w.on("error", () => { ctx.dirty.add(lower(d)); });
      ctx.watchers[tree].push(w);
    } catch (e) { log(`${short(path.basename(d))} 감시 실패: ${e.code || ""} ${e.message}`); }
  }
}

/* ---------- 백업 ---------- */
const dirsByNewest = (dir) => safeReaddir(dir).map((n) => path.join(dir, n)).filter((p) => kind(p) === "dir").sort((a, b) => mtime(b) - mtime(a));
const snapshotDirs = () => dirsByNewest(BACKUP_DIR).filter((p) => /^\d{8}-\d{2}(\d{4}-[a-z-]+)?$/.test(path.basename(p)));

function fullestDir(ctx) {
  let best = null, n = -1;
  for (const d of ctx.family["claude-code-sessions"] || []) { const c = countRecords(d); if (c > n) { n = c; best = d; } }
  return best;
}

function snapshot(ctx, tag) {
  const src = fullestDir(ctx);
  if (!src) return;
  const dest = path.join(BACKUP_DIR, tag ? `${secStamp()}-${tag}` : hourStamp());
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: (p) => !isTempName(path.basename(p)) });
  const hourly = snapshotDirs().filter((p) => /^\d{8}-\d{2}$/.test(path.basename(p)));
  for (const p of hourly.slice(SNAPSHOT_KEEP)) fs.rmSync(p, { recursive: true, force: true });
}

// 맞추기 전 전체 백업: 모든 뿌리의 두 트리를 짝 폴더째 복사한다(계정마다 다른 파일이 더 최근 것으로 덮이기 전에).
// 뿌리가 둘 이상이면 root1, root2…로 나누고 roots.txt에 원래 위치를 적는다.
function snapshotAll(tag) {
  const roots = findRoots();
  if (roots.length === 0) return null;
  const dest = path.join(BACKUP_DIR, `${secStamp()}-${tag}`);
  if (fs.existsSync(dest)) return null;
  roots.forEach((r, i) => {
    for (const tree of TREES) {
      const src = path.join(r, tree);
      if (kind(src) !== "dir") continue;
      const to = path.join(dest, roots.length > 1 ? `root${i + 1}` : "", tree);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(src, to, { recursive: true, filter: (p) => !isTempName(path.basename(p)) && kind(p) !== "link" });
    }
  });
  if (roots.length > 1) fs.writeFileSync(path.join(dest, "roots.txt"), roots.map((r, i) => `root${i + 1}\t${r}`).join("\n") + "\n");
  return dest;
}

/* ---------- 한 바퀴 ---------- */
function tick(ctx, opts = {}) {
  const { state } = ctx;
  const ev = readLogEvents(state, findMainLog());
  // 상태 파일 없이 처음 읽은 기록(설치 직후 첫 맞추기)은 지난 일이라 알리지 않는다. 설치기가 따로 「껐다 켜세요」를 알려 준다.
  const history = ctx.freshState && !ctx.logReadOnce;
  ctx.logReadOnce = true;
  const seen = (key) => { if (!state.known[key]) { state.known[key] = new Date().toISOString(); ctx.stateDirty = true; return true; } return false; };
  let newPair = false;
  for (const key of ev.inits) { if (seen(key)) newPair = true; state.active = key; }
  if (ev.logout) state.active = null;
  if (Date.now() - (ctx.lastConfigScan || 0) >= CONFIG_SCAN_MS) {
    ctx.lastConfigScan = Date.now();
    for (const key of pairsFromConfigs()) if (seen(key)) newPair = true;
  }
  // rootsMoved: 짝 폴더가 통째로 없어졌다(앱이 데이터를 다른 자리로 옮김) — 1분을 기다리지 않고 뿌리를 다시 찾는다.
  if (newPair || ctx.rootsMoved || !ctx.family || Date.now() - (ctx.lastFamilyScan || 0) >= CONFIG_SCAN_MS) { ctx.lastFamilyScan = Date.now(); ctx.rootsMoved = false; refreshFamily(ctx); }
  if (!ctx.family) return;
  // 앱이 어떤 짝 폴더에서 세션을 0개 읽었고 메모리에도 없었는데(existingSessions=0) 다른 폴더엔 기록이 있으면, 채운 뒤 「껐다 켜기」를 알린다.
  // 같은 계정 재로그인(existingSessions>0 뒤 「Loaded 0」)은 목록이 이미 보이는 상태라 빈 목록으로 치지 않는다.
  const codeLoads = ev.loaded.filter((e) => e.n === 0 && e.tree === "claude-code-sessions");
  for (const e of codeLoads) if (e.existing > 0) log(`${short(e.key)}: 같은 계정으로 다시 로그인함(목록에 이미 ${e.existing}개) — 알림 없음`);
  const emptyLoads = codeLoads.filter((e) => !(e.existing > 0));
  const full = opts.full || Date.now() - (ctx.lastFull || 0) >= FULL_SCAN_MS || newPair || emptyLoads.length > 0;
  if (full) ctx.lastFull = Date.now();
  for (const tree of TREES) {
    try { syncTree(ctx, tree, { full }); } catch (e) { log(`${tree} 맞추기 오류: ${e.code || ""} ${e.message}`); for (const d of ctx.family[tree] || []) ctx.dirty.add(lower(d)); }
    try { syncRegistry(ctx, tree, ev.inits); } catch (e) { log(`${tree} 예약 목록 맞추기 오류: ${e.code || ""} ${e.message}`); }
  }
  let filled = 0;
  for (const e of emptyLoads) {
    const d = path.join(ctx.primary || "", "claude-code-sessions", ...e.key.split("/"));
    const n = countRecords(d);
    if (n > 0) {
      log(`${short(e.key)}에서 앱이 세션 0개를 읽었음 — 지금은 ${n}개 채워져 있어 껐다 켜면 보임`);
      filled = Math.max(filled, n);
    }
  }
  // 알림은 한 바퀴에 한 번만 띄운다(처음 설치할 때 지난 기록을 한꺼번에 읽어도 알림이 쏟아지지 않게).
  if (filled && history) log(`처음 읽은 지난 기록이라 알림은 띄우지 않음(세션 ${filled}개 채움)`);
  if (filled && !history) notify("Claude 세션 공유 · 한 번만 껐다 켜 주세요",
    `이 PC에서 처음 쓰는 계정이라 목록이 비어 보였어요. 이전 세션 ${filled}개를 채웠어요.`,
    "작업 표시줄 ^ 안 Claude 아이콘 → 오른쪽 클릭 → 종료 → 다시 실행");
  if (Date.now() - (ctx.lastSnapshot || 0) >= SNAPSHOT_MS) {
    ctx.lastSnapshot = Date.now();
    try { snapshot(ctx); } catch (e) { log(`백업 실패: ${e.message}`); }
  }
  if (ctx.stateDirty) scheduleStateWrite(ctx);
}

function writeState(ctx) {
  ctx.stateDirty = false;
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ctx.state));
  fs.renameSync(tmp, STATE_PATH);
}

function scheduleStateWrite(ctx) {
  if (!ctx.daemon) { writeState(ctx); return; }
  if (ctx.stateTimer) return;
  ctx.stateTimer = setTimeout(() => { ctx.stateTimer = null; try { writeState(ctx); } catch (e) { log(`상태 저장 실패: ${e.message}`); } }, STATE_WRITE_DEBOUNCE_MS);
}

function scheduleTick(ctx, ms) {
  if (ctx.tickTimer) return;
  ctx.tickTimer = setTimeout(() => { ctx.tickTimer = null; runTick(ctx); }, ms);
}

function runTick(ctx) {
  if (ctx.ticking) { ctx.dirtyAgain = true; return; }
  ctx.ticking = true;
  try { tick(ctx); } catch (e) { log(`오류: ${e.code || ""} ${e.message}`); }
  finally { ctx.ticking = false; }
  if (ctx.dirtyAgain) { ctx.dirtyAgain = false; scheduleTick(ctx, WATCH_DEBOUNCE_MS); }
}

/* ---------- 상태 ---------- */
function loadState() {
  const s = tryJson(STATE_PATH) || {};
  // v1(junction 판) 상태에서 이어받을 것: 로그 위치·알려진 짝·지금 계정. home은 더 쓰지 않는다.
  const union = s.v === 2 ? s.union || {} : {};
  for (const tree of TREES) if (union[tree]) delete union[tree][REGISTRY]; // 예약 목록은 파일 미러에서 뺐다
  return { v: 2, logPath: s.logPath, logOffset: s.logOffset || 0, known: s.known || {}, active: s.active || null, union, synced: s.v === 2 ? s.synced || {} : {}, tasks: s.v === 2 ? s.tasks || {} : {}, existing: s.v === 2 ? s.existing || {} : {} };
}

function makeCtx(daemon) {
  // freshState: 상태 파일이 아직 없음(처음 설치). 이때 처음 읽는 앱 기록은 지난 일이다.
  return { state: loadState(), daemon, freshState: !fs.existsSync(STATE_PATH), manifests: {}, dirty: new Set(), fullScanned: {}, watchers: {}, family: null, stateDirty: false };
}

function runningPid() {
  const pid = parseInt(tryJson(PID_PATH) ?? "0", 10);
  if (!pid || pid === process.pid) return 0;
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, encoding: "utf8" });
  return /"node\.exe"/i.test(r.stdout || "") ? pid : 0;
}

function printStatus(ctx) {
  const state = ctx?.state || loadState();
  const roots = findRoots();
  const running = runningPid();
  console.log(`앱 데이터: ${roots.join(" ; ") || "(못 찾음 — Code 탭을 쓰기 시작하면 생깁니다)"}`);
  console.log(`지켜보기: ${running ? `실행 중 (pid ${running})` : "꺼져 있음 — 설치 한 줄을 다시 실행하면 켜집니다"}`);
  console.log(`지금 계정: ${state.active ? short(state.active) : "(로그아웃 상태이거나 아직 모름 — Claude에 로그인하면 표시)"}`);
  const LABEL = { "claude-code-sessions": "Code 탭 세션", "local-agent-mode-sessions": "Cowork 세션" };
  for (const tree of TREES) {
    const synced = new Set((state.synced[tree] || []).map(lower));
    const rows = [];
    const sums = []; // 맞춰졌는지 한 줄로 판정하려고 폴더마다 (세션 기록 수, 파일 수, 맞춤 여부)를 모은다
    for (const r of roots) for (const key of pairsFromDirs(path.join(r, tree))) {
      const p = path.join(r, tree, ...key.split("/")), k = kind(p);
      const n = k === "dir" ? countRecords(p) : 0;
      const files = k === "dir" ? scanDir(p).size : 0;
      const reg = k === "dir" ? readRegistry(p) : null;
      const tasks = reg ? (reg.bad ? ", 예약 목록 읽기 실패" : `, 예약 ${reg.ids.length}개`) : "";
      const extra = k === "dir" ? `${n}개 세션 기록, 파일 ${files}개${tasks}` : k === "link" ? "바로 가기 폴더(다음 맞춤 때 실제 폴더로 바꿈)" : k;
      const ok = synced.has(lower(p));
      rows.push(`${key === state.active ? "★" : " "} ${key}  ${extra}${ok ? "" : "  (아직 안 맞춤 — 몇 초 뒤 다시 보세요)"}`);
      sums.push({ n, files, dir: k === "dir", ok });
    }
    console.log(`${LABEL[tree] || tree}(${tree}): ${rows.length}곳, 맞춘 파일 ${Object.keys(state.union[tree] || {}).length}개`);
    const R = state.tasks?.[tree];
    if (R) { const ids = R.order.filter((id) => R.union[id]); console.log(`  예약 작업 ${ids.length}개${ids.length ? `: ${ids.join(", ")}` : ""}`); }
    for (const row of rows) console.log(row);
    // 판정 한 줄: 처음 보는 사람도 표를 다 읽지 않고 알 수 있게
    if (sums.length === 0) console.log("  (없음 — 쓰지 않으면 정상입니다)");
    else if (sums.length === 1) console.log("  (계정 폴더가 하나뿐 — 다른 계정으로 로그인하면 함께 맞춥니다)");
    else if (sums.every((s) => s.dir && s.ok && s.n === sums[0].n && s.files === sums[0].files)) console.log(`  ○ ${sums.length}곳이 모두 같습니다(세션 ${sums[0].n}개)`); // ○·△는 한글 기본 글꼴(KS X 1001)에 있어 옛 콘솔에서도 보인다
    else console.log(`  △ 아직 서로 다른 폴더가 있습니다 — ${running ? "몇 초 뒤 다시 보세요" : "지켜보기가 꺼져 있습니다. 설치 한 줄을 다시 실행하세요"}`);
  }
  const snaps = snapshotDirs();
  console.log(`백업: ${snaps.length}개${snaps[0] ? `, 최근 ${path.basename(snaps[0])}` : ""}`);
}

/* ---------- 실행 ---------- */
const args = new Set(process.argv.slice(2));
const mode = args.has("--help") || args.has("-h") ? "help" : args.has("--status") ? "status" : args.has("--once") ? "once" : "watch";
const boxed = mode === "help" ? null : redirectedTo();
if (mode === "help") {
  console.log(`claude-session-share — Claude 데스크톱 세션 목록을 모든 계정 폴더에 똑같이 맞춘다
  node claude-session-share.mjs                  계속 지켜보기(보통은 시작프로그램이 띄운다)
  node claude-session-share.mjs --once           한 번 맞추고 끝
  node claude-session-share.mjs --once --backup  모든 계정 폴더를 먼저 백업하고 한 번 맞추기
  node claude-session-share.mjs --status         상태 보기
데이터 폴더: ${DATA_DIR}`);
} else if (mode === "status") {
  if (boxed) console.log(`(주의) ${BOXED_MSG(boxed)} 여기서 보이는 상태는 실제와 다를 수 있습니다.`);
  printStatus();
} else if (boxed) {
  // 맞추기·지켜보기는 하지 않는다(상태·pid가 앱 전용 폴더에 따로 생겨 지켜보기가 둘이 될 수 있다).
  console.error(BOXED_MSG(boxed));
  process.exitCode = 1;
} else if (mode === "once") {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const ctx = makeCtx(false);
  if (runningPid()) console.log(`(지켜보기가 pid ${runningPid()}로 돌고 있어 같이 맞춥니다)`);
  let backupOk = true;
  if (args.has("--backup")) {
    try {
      const dest = snapshotAll("before-mirror");
      if (dest) { log(`맞추기 전 전체 백업: ${dest}`); console.log(`맞추기 전 전체 백업: ${dest}`); }
    } catch (e) {
      backupOk = false;
      log(`백업 실패: ${e.message}`);
      console.error(`백업 실패 — 맞추지 않고 멈춥니다: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (backupOk) {
    tick(ctx, { full: true });
    writeState(ctx);
    printStatus(ctx);
  }
} else {
  const other = runningPid();
  if (other) { console.log(`이미 실행 중 (pid ${other})`); process.exit(0); }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_PATH, JSON.stringify(process.pid));
  const ctx = makeCtx(true);
  log("지켜보기 시작(v2 미러)");
  runTick(ctx);
  setInterval(() => {
    // 폴더 자체의 mtime이 바뀌면(파일 추가·삭제·이름 바꾸기) 그 폴더만 다시 본다. 감시(fs.watch)가 놓친 것의 뒷받침.
    if (ctx.family) for (const tree of TREES) for (const d of ctx.family[tree] || []) {
      const m = mtime(d), k = lower(d);
      if (ctx.dirMtimes?.has(k) && ctx.dirMtimes.get(k) !== m) ctx.dirty.add(k);
      (ctx.dirMtimes ||= new Map()).set(k, m);
    }
    runTick(ctx);
  }, POLL_MS);
  process.on("SIGINT", () => { try { writeState(ctx); } catch {} process.exit(0); });
  process.on("SIGTERM", () => { try { writeState(ctx); } catch {} process.exit(0); });
}

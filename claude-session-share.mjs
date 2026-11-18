// Preserve the installed Node command line for scripts written before the native release.
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const adjacent = fileURLToPath(new URL("./claude-session-share.exe", import.meta.url));
const bundled = fileURLToPath(new URL("./dist/windows-x64/claude-session-share.exe", import.meta.url));
const installed = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "claude-session-share", "claude-session-share.exe");
const exe = [adjacent, installed, bundled].find((p) => p && existsSync(p));
if (!exe) {
  console.error("Rust 실행 파일을 찾을 수 없습니다. install.ps1으로 공유기를 설치하세요.");
  process.exit(1);
}
const args = process.argv.slice(2);
if (args.length) {
  const result = spawnSync(exe, args, { stdio: "inherit", windowsHide: true });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} else {
  const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.unref();
}

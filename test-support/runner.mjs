import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const script = process.env.CLAUDE_SESSION_SHARE_SCRIPT ||
  fileURLToPath(new URL("../legacy/claude-session-share.mjs", import.meta.url));
const nativeExe = process.env.CLAUDE_SESSION_SHARE_TEST_EXE;
export const command = nativeExe || process.execPath;
export const args = nativeExe ? [] : [script];

// 개인 설정에 추가한 계정 경로와 타이머 값이 시험에 들어오지 않게 한다.
export const sandboxEnv = Object.fromEntries(Object.entries(process.env).filter(
  ([key]) => key.toUpperCase() !== "CLAUDE_CONFIG_DIR" && !key.toUpperCase().startsWith("CLAUDE_SESSION_SHARE_")
));

export const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-session-share-test-"));
after(() => fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5 }));

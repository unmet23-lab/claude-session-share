use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde_json::{json, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, IsTerminal, Write};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, CREATE_NO_WINDOW, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::{
    discovery::{count_records, lower, pairs_from_dirs, real_dir, short},
    mirror::file_count,
    TREES,
};

pub fn log(msg: &str) {
    let Ok(data) = crate::discovery::data_dir() else {
        return;
    };
    let file = data.join("claude-session-share.log");
    let line = format!(
        "{} {msg}\n",
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    );
    if file.metadata().is_ok_and(|m| m.len() > 512 * 1024) {
        if let Ok(text) = fs::read(&file) {
            let start = text.len() / 2;
            let offset = text[start..]
                .iter()
                .position(|&b| b == b'\n')
                .map_or(start, |i| i + start + 1);
            let _ = fs::write(&file, &text[offset..]);
        }
    }
    if let Ok(mut f) = OpenOptions::new().append(true).create(true).open(file) {
        let _ = f.write_all(line.as_bytes());
    }
    if io::stdout().is_terminal() {
        let _ = io::stdout().write_all(line.as_bytes());
    }
}

fn powershell() -> Command {
    let path = PathBuf::from(env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut cmd = Command::new(path);
    cmd.creation_flags(CREATE_NO_WINDOW).args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
    ]);
    cmd
}

fn notify(lines: &[&str]) {
    if let Some(path) = env::var_os("CLAUDE_SESSION_SHARE_NOTIFY_FILE") {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{}", lines.join(" | "));
        }
        return;
    }
    let template = if lines.len() > 2 {
        "ToastText04"
    } else {
        "ToastText02"
    };
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::{template})
$x.GetElementsByTagName('binding').Item(0).SetAttribute('template', 'ToastGeneric')
$t = $x.GetElementsByTagName('text')
for ($i = 0; $i -lt $t.Length; $i++) {{
    $s = [Environment]::GetEnvironmentVariable("CSS_TOAST_$i")
    if ($s) {{ $null = $t.Item($i).AppendChild($x.CreateTextNode($s)) }}
}}
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}}\WindowsPowerShell\v1.0\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))
"#
    );
    let mut cmd = powershell();
    for (i, s) in lines.iter().enumerate() {
        cmd.env(format!("CSS_TOAST_{i}"), s);
    }
    match cmd
        .args(["-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Err(err) => log(&format!("알림을 띄우지 못함: {err}")),
        Ok(mut child) => {
            let mut wait = move || {
                let start = Instant::now();
                loop {
                    match child.try_wait() {
                        Ok(Some(code)) => {
                            if !code.success() {
                                log(&format!("알림 PowerShell 종료: {code}"));
                            }
                            break;
                        }
                        Ok(None) if start.elapsed() < Duration::from_secs(30) => {
                            std::thread::sleep(Duration::from_millis(100))
                        }
                        _ => {
                            let _ = child.kill();
                            let _ = child.wait();
                            log("알림 PowerShell 시간 초과");
                            break;
                        }
                    }
                }
            };
            if env::args().any(|a| a == "--once") {
                wait();
            } else {
                std::thread::spawn(wait);
            }
        }
    }
}

pub fn notify_filled(n: usize) {
    notify(&[
        "Claude 세션 공유 · 한 번만 껐다 켜 주세요",
        &format!("이 PC에서 처음 쓰는 계정이라 목록이 비어 보였어요. 이전 세션 {n}개를 채웠어요."),
        "작업 표시줄 ^ 안 Claude 아이콘 → 오른쪽 클릭 → 종료 → 다시 실행",
    ]);
}
pub fn notify_restored(n: usize) {
    notify(&["Claude 세션 공유", &format!("예약 작업 {n}개가 이 계정 목록에서 빠져 다시 넣었어요. Claude를 한 번 껐다 켜면 다시 돌아요.")]);
}

pub fn running_pid(data: &Path) -> Option<u32> {
    let pid = fs::read_to_string(data.join("claude-session-share.pid"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    if pid == 0 || pid == process::id() {
        return None;
    }
    let mut buf = vec![0u16; 32768];
    let mut size = buf.len() as u32;
    // QueryFullProcessImageNameW only needs limited query access.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
    }
    let image = PathBuf::from(std::ffi::OsString::from_wide(&buf[..size as usize]));
    let exe = image.file_name()?.to_str()?;
    if exe.eq_ignore_ascii_case("claude-session-share.exe") {
        return Some(pid);
    }
    if !exe.eq_ignore_ascii_case("node.exe") {
        return None;
    }
    // A stale PID may now belong to an unrelated Node application.
    let output = powershell()
        .args([
            "-Command",
            &format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine"),
        ])
        .output()
        .ok()?;
    let cmd = String::from_utf8_lossy(&output.stdout).to_lowercase();
    cmd.contains("claude-session-share.mjs").then_some(pid)
}

pub fn load_state(data: &Path) -> Value {
    let old: Value = fs::read(data.join("claude-session-share.json"))
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or(Value::Null);
    let mut s = json!({"v":2,"logOffset":0,"known":{},"active":null,"union":{},"synced":{},"tasks":{},"existing":{},"parked":{},"transient":{},"pendingInit":null});
    for key in ["logPath", "logOffset", "known", "active"] {
        if let Some(v) = old.get(key).filter(|v| !v.is_null()) {
            s[key] = v.clone();
        }
    }
    if old["v"] == 2 {
        for key in [
            "union",
            "synced",
            "tasks",
            "existing",
            "parked",
            "transient",
            "pendingInit",
        ] {
            if let Some(v) = old.get(key).filter(|v| !v.is_null()) {
                s[key] = v.clone();
            }
        }
    }
    for tree in TREES {
        if let Some(m) = s["union"].get_mut(tree).and_then(Value::as_object_mut) {
            m.remove("scheduled-tasks.json");
        }
    }
    s
}

pub fn write_state(data: &Path, state: &Value) -> io::Result<()> {
    let path = data.join("claude-session-share.json");
    let tmp = data.join(format!(".state-{}.tmp", process::id()));
    let result = (|| {
        let mut f = io::BufWriter::new(fs::File::create(&tmp)?);
        serde_json::to_writer(&mut f, state)?;
        f.flush()?;
        f.get_ref().sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

pub fn redirected_to(local: &Path) -> Option<String> {
    let name = format!(
        ".claude-session-share-probe-{}-{}",
        process::id(),
        Utc::now().timestamp_subsec_nanos()
    );
    let probe = local.join(&name);
    drop(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe)
            .ok()?,
    );
    let found = fs::read_dir(local.join("Packages"))
        .into_iter()
        .flatten()
        .flatten()
        .find(|p| p.path().join("LocalCache/Local").join(&name).exists())
        .map(|p| p.file_name().to_string_lossy().into_owned());
    let _ = fs::remove_file(probe);
    found
}

static STOP: AtomicBool = AtomicBool::new(false);
unsafe extern "system" fn ctrl(_: u32) -> i32 {
    STOP.store(true, Ordering::Relaxed);
    1
}
pub fn install_shutdown_handler() {
    unsafe {
        SetConsoleCtrlHandler(Some(ctrl), 1);
    }
}
pub fn stopping() -> bool {
    STOP.load(Ordering::Relaxed)
}

pub fn print_status(data: &Path, s: &Value, roots: &[PathBuf], batch: u64) {
    let pid = running_pid(data);
    println!(
        "앱 데이터: {}",
        if roots.is_empty() {
            "(못 찾음 — Code 탭을 쓰기 시작하면 생깁니다)".to_owned()
        } else {
            roots
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(" ; ")
        }
    );
    println!(
        "지켜보기: {}",
        pid.map_or(
            "꺼져 있음 — 설치 한 줄을 다시 실행하면 켜집니다".to_owned(),
            |p| format!("실행 중 (pid {p})")
        )
    );
    let active = s["active"].as_str().unwrap_or("");
    let short = short(active);
    println!(
        "지금 계정: {}",
        if short.is_empty() {
            "(로그아웃 상태이거나 아직 모름 — Claude에 로그인하면 표시)"
        } else {
            &short
        }
    );
    for (tree, label) in TREES.into_iter().zip(["Code 탭 세션", "Cowork 세션"]) {
        let synced = s["synced"][tree].as_array();
        let mut rows = Vec::new();
        let mut sums = Vec::new();
        for root in roots {
            let base = root.join(tree);
            for key in pairs_from_dirs(&base) {
                let p = base.join(&key);
                let dir = real_dir(&p);
                let files = if dir { file_count(&p) } else { 0 };
                if dir
                    && files == 0
                    && s["known"][&key].is_null()
                    && (!s["transient"][&key].is_null() || s["pendingInit"]["key"] == key)
                {
                    rows.push(format!("  {key}  (앱이 계정을 바꾸며 잠깐 거친 짝 — 맞추지 않고 두었다가 쉬게 합니다)"));
                    continue;
                }
                let n = if dir { count_records(&p) } else { 0 };
                let path = lower(&p);
                let ok = synced.is_some_and(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .any(|v| lower(Path::new(v)) == path)
                });
                let reg = if dir {
                    fs::read(p.join("scheduled-tasks.json")).ok()
                } else {
                    None
                };
                let tasks = reg
                    .map(|bytes| {
                        serde_json::from_slice::<Value>(&bytes)
                            .ok()
                            .and_then(|j| {
                                j["scheduledTasks"].as_array().map(|ts| {
                                    ts.iter()
                                        .filter(|t| {
                                            t["id"].as_str().is_some_and(|id| !id.is_empty())
                                        })
                                        .count()
                                })
                            })
                            .map_or(", 예약 목록 읽기 실패".into(), |n| {
                                format!(", 예약 {n}개")
                            })
                    })
                    .unwrap_or_default();
                let extra = if dir {
                    format!("{n}개 세션 기록, 파일 {files}개{tasks}")
                } else {
                    "바로 가기 폴더(다음 맞춤 때 실제 폴더로 바꿈)".into()
                };
                rows.push(format!(
                    "{} {key}  {extra}{}",
                    if active == key { "★" } else { " " },
                    if ok {
                        ""
                    } else {
                        "  (아직 안 맞춤 — 몇 초 뒤 다시 보세요)"
                    }
                ));
                sums.push((dir && ok, n, files));
            }
        }
        println!(
            "{label}({tree}): {}곳, 맞춘 파일 {}개",
            rows.len(),
            s["union"][tree].as_object().map_or(0, |m| m.len())
        );
        if let Some(ids) = s["tasks"][tree]["order"].as_array() {
            let ids = ids
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| !s["tasks"][tree]["union"][id].is_null())
                .collect::<Vec<_>>();
            println!(
                "  예약 작업 {}개{}",
                ids.len(),
                if ids.is_empty() {
                    String::new()
                } else {
                    format!(": {}", ids.join(", "))
                }
            );
        }
        for row in rows {
            println!("{row}");
        }
        match sums.as_slice() {
            [] => println!("  (없음 — 쓰지 않으면 정상입니다)"),
            [_] => println!("  (계정 폴더가 하나뿐 — 다른 계정으로 로그인하면 함께 맞춥니다)"),
            [first, ..] if first.0 && sums.iter().all(|v| v == first) => {
                println!("  ○ {}곳이 모두 같습니다(세션 {}개)", sums.len(), first.1)
            }
            _ => println!(
                "  △ 아직 서로 다른 폴더가 있습니다 — {}",
                if pid.is_some() {
                    "몇 초 뒤 다시 보세요"
                } else {
                    "지켜보기가 꺼져 있습니다. 설치 한 줄을 다시 실행하세요"
                }
            ),
        }
        let parked = s["parked"][tree].as_object().map_or(0, |m| m.len());
        if parked > 0 {
            println!("  쉬는 짝 폴더 {parked}곳(이 PC에서 로그인한 기록이 없음 — 그 계정으로 처음 로그인하면 바로 채우고 「껐다 켜기」를 알립니다)");
        }
    }
    let unit = if batch.is_multiple_of(60000) {
        format!("{}분", batch / 60000)
    } else {
        format!("{}초", (batch + 500) / 1000)
    };
    println!("맞추는 방식: 새 세션·지운 세션·로그인·로그아웃은 바로, 이미 있는 기록을 고쳐 쓴 것은 {unit}씩 모아서");
    let pattern = Regex::new(r"^\d{8}-\d{2}(\d{4}-[a-z-]+)?$").unwrap();
    let mut snaps: Vec<_> = fs::read_dir(data.join("claude-session-backups"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| pattern.is_match(n))
        .collect();
    snaps.sort();
    println!(
        "백업: {}개{}",
        snaps.len(),
        snaps
            .last()
            .map_or(String::new(), |n| format!(", 최근 {n}"))
    );
}

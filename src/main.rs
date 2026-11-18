mod backup;
mod discovery;
mod identity;
mod mirror;
mod platform;
mod registry;
mod sessions;
mod watch;

use discovery::{FamilyScan, Paths};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    env, fs, io,
    path::{Path, PathBuf},
    process, thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const TREES: [&str; 2] = ["claude-code-sessions", "local-agent-mode-sessions"];
pub type Family = BTreeMap<String, Vec<PathBuf>>;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn env_ms(key: &str, default: u64) -> u64 {
    env::var(format!("CLAUDE_SESSION_SHARE_{key}"))
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.)
        .map(|v| v as u64)
        .unwrap_or(default)
}

struct Daemon {
    paths: Paths,
    state: Value,
    family: FamilyScan,
    logs: sessions::SessionLogs,
    engine: mirror::Engine,
    watches: watch::Watches,
    waiting: HashMap<String, u64>,
    fresh: bool,
    watching: bool,
    batch: u64,
    last_scan: u64,
    last_family: u64,
    last_full: u64,
    last_backup: u64,
    last_restore: u64,
    last_logout: u64,
    retry_at: u64,
    retry_delay: u64,
    last_write: u64,
    write_due: Option<u64>,
}
impl Daemon {
    fn new(paths: Paths, watch: bool) -> Self {
        let state = platform::load_state(&paths.data);
        let fresh = !paths.data.join("claude-session-share.json").exists();
        let family = FamilyScan::new(&paths.data);
        Self {
            paths,
            state,
            family,
            logs: Default::default(),
            engine: Default::default(),
            watches: watch::Watches::new(watch),
            waiting: HashMap::new(),
            fresh,
            watching: watch,
            batch: env_ms("BATCH_MS", 300000),
            last_scan: 0,
            last_family: 0,
            last_full: 0,
            last_backup: 0,
            last_restore: 0,
            last_logout: 0,
            retry_at: 0,
            retry_delay: 0,
            last_write: 0,
            write_due: None,
        }
    }
    fn save(&mut self) -> io::Result<()> {
        platform::write_state(&self.paths.data, &self.state)?;
        self.write_due = None;
        self.last_write = now();
        Ok(())
    }
    fn schedule_save(&mut self, urgent: bool, t: u64) {
        let at = (t + 2000).max(if urgent { 0 } else { self.last_write + 60000 });
        self.write_due = Some(self.write_due.map_or(at, |old| old.min(at)));
    }
    fn tick(&mut self, force: bool) {
        let t = now();
        self.watches.poll(t);
        let scan = t.saturating_sub(self.last_scan) >= 60000;
        if scan {
            self.last_scan = t;
        }
        let ev = self.logs.read(&self.paths, &mut self.state, t, scan);
        let history = std::mem::take(&mut self.fresh);
        if ev.logout {
            self.last_logout = t;
        } else if !ev.inits.is_empty() {
            self.last_logout = 0;
        }
        let mut urgent = ev.urgent;
        let mut changed = false;
        let refresh = force
            || ev.new_pair
            || self.watches.moved
            || self.family.primary.is_none()
            || (self.family.error.is_some() && t.saturating_sub(self.last_family) >= 3000)
            || t.saturating_sub(self.last_family) >= 60000;
        let mut family_changed = false;
        if refresh {
            let before = self.family.dirs.clone();
            self.watches.moved = false;
            self.last_family = t;
            urgent |= self.family.refresh(
                &self.paths,
                &mut self.state,
                self.logs.logged_pairs.as_ref(),
                &mut self.engine,
                t,
            );
            family_changed = self.family.dirs != before || !self.family.recreated.is_empty();
            self.watches
                .refresh(&self.family.dirs, &self.family.recreated);
        }
        let full = force
            || ev.new_pair
            || ev.logged
            || family_changed
            || t.saturating_sub(self.last_full) >= 300000;
        let retry = self.retry_at > 0 && t >= self.retry_at;
        let due = full
            || retry
            || (!self.watches.dirty.is_empty()
                && (self.watches.urgent
                    || t.saturating_sub(self.last_logout) < 600000
                    || self
                        .watches
                        .since
                        .is_some_and(|s| t.saturating_sub(s) >= self.batch)));
        let mut failed = 0;
        if full {
            self.last_full = t;
        }
        if due {
            self.watches.since = None;
            self.watches.urgent = false;
            self.retry_at = 0;
        }
        for tree in TREES {
            let Some(dirs) = self.family.dirs.get(tree) else {
                continue;
            };
            if due {
                match self.engine.sync(
                    tree,
                    dirs,
                    &mut self.state,
                    &self.watches.dirty,
                    full || retry,
                ) {
                    Ok(out) => {
                        changed |= out.changed;
                        failed += out.failed;
                        self.watches.moved |= out.roots_moved;
                        for d in out.scanned {
                            self.watches.dirty.remove(&d);
                        }
                        self.watches.updated(out.written);
                    }
                    Err(e) => {
                        failed += 1;
                        platform::log(&format!("{tree} 맞추기 오류: {e}"));
                    }
                }
            }
            match registry::sync(tree, dirs, &mut self.state, &ev.inits) {
                Ok(out) => {
                    changed |= out.changed;
                    self.watches.updated(out.written);
                    if self.watching
                        && out.restored > 0
                        && t.saturating_sub(self.last_restore) >= 3600000
                    {
                        self.last_restore = t;
                        platform::notify_restored(out.restored);
                    }
                }
                Err(e) => platform::log(&format!("{tree} 예약 목록 맞추기 오류: {e}")),
            }
        }
        if due {
            if failed > 0 {
                self.retry_delay =
                    (self.retry_delay.saturating_mul(2)).clamp(3000, self.batch.max(3000));
                self.retry_at = t.saturating_add(self.retry_delay);
            } else {
                self.retry_delay = 0;
            }
        }
        if !self.watches.dirty.is_empty() {
            self.watches.since.get_or_insert(t);
        }
        for k in ev.empty {
            self.waiting.insert(k, t);
        }
        let mut filled = 0;
        self.waiting.retain(|k, at| {
            if self.state["known"][k].is_null() {
                return self.state["transient"][k].is_null() && t.saturating_sub(*at) <= 300000;
            }
            if let Some(p) = &self.family.primary {
                filled = filled.max(discovery::count_records(&p.join(TREES[0]).join(k)));
            }
            false
        });
        if filled > 0 && !history {
            platform::notify_filled(filled);
        }
        if self.family.primary.is_some() && t.saturating_sub(self.last_backup) >= 3600000 {
            self.last_backup = t;
            if let Err(e) = backup::snapshot(&self.paths.data, &self.family.dirs, &self.state) {
                platform::log(&format!("백업 실패: {e}"));
            }
        }
        self.engine.expire_own();
        if changed || urgent {
            self.schedule_save(urgent, t);
        }
    }
    fn once(&mut self, backup: bool) -> io::Result<Option<PathBuf>> {
        let dst = if backup {
            backup::snapshot_all(&self.paths.data, &self.paths.roots())?
        } else {
            None
        };
        if let Some(p) = &dst {
            platform::log(&format!("맞추기 전 전체 백업: {}", p.display()));
        }
        self.tick(true);
        if let Some(error) = &self.family.error {
            return Err(io::Error::other(error.clone()));
        }
        self.save()?;
        Ok(dst)
    }
    fn handle_requests(&mut self) -> bool {
        let mut stop = false;
        for name in discovery::names(&self.paths.data) {
            if !request_name(&name) {
                continue;
            }
            let ready = self.paths.data.join(&name);
            let Ok(op) = fs::read_to_string(&ready) else {
                continue;
            };
            let result = match op.as_str() {
                "stop" => self.save().map(|_| {
                    stop = true;
                    Value::Null
                }),
                "backup-only" => {
                    backup::snapshot_all(&self.paths.data, &self.paths.roots()).map(|p| json!(p))
                }
                "once" | "backup" => self.once(op == "backup").map(|p| json!(p)),
                _ => Err(io::Error::new(io::ErrorKind::InvalidInput, "잘못된 요청")),
            };
            let answer = match result {
                Ok(data) => json!({"ok":data}),
                Err(e) => json!({"error":e.to_string()}),
            };
            let tmp = ready.with_extension("writing");
            let done = ready.with_extension("done");
            if fs::write(&tmp, answer.to_string())
                .and_then(|_| fs::rename(&tmp, &done))
                .is_ok()
            {
                let _ = fs::remove_file(&ready);
            }
        }
        stop
    }
    fn run(&mut self) -> io::Result<()> {
        platform::install_shutdown_handler();
        platform::log("지켜보기 시작(Rust)");
        self.tick(false);
        let mut next_poll = now() + 1000;
        let mut watch_due: Option<u64> = None;
        loop {
            let t = now();
            if platform::stopping() {
                self.save()?;
                return Ok(());
            }
            if t >= next_poll {
                if self.handle_requests() {
                    return Ok(());
                }
                self.tick(false);
                next_poll = now() + 1000;
                watch_due = None;
            } else if watch_due.is_some_and(|s| t >= s) {
                self.tick(false);
                watch_due = None;
            }
            let t = now();
            if self.write_due.is_some_and(|s| t >= s) {
                if let Err(e) = self.save() {
                    platform::log(&format!("상태 저장 실패: {e}"));
                    self.write_due = Some(t + 2000);
                }
            }
            if self.watches.urgent {
                watch_due.get_or_insert(t + 150);
            }
            let end = next_poll
                .min(watch_due.unwrap_or(u64::MAX))
                .min(self.write_due.unwrap_or(u64::MAX));
            self.watches.wait(
                Duration::from_millis(end.saturating_sub(t).min(1000)),
                &self.engine,
                &self.state,
            );
        }
    }
}
fn request_name(name: &str) -> bool {
    name.strip_prefix(".request-")
        .and_then(|n| n.strip_suffix(".ready"))
        .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit() || b == b'-'))
}
fn relay(data: &Path, op: &str, lock: &fs::File) -> io::Result<Option<PathBuf>> {
    let id = format!(".request-{}-{}", process::id(), now());
    let tmp = data.join(format!("{id}.tmp"));
    let ready = data.join(format!("{id}.ready"));
    let done = data.join(format!("{id}.done"));
    fs::write(&tmp, op)?;
    fs::rename(&tmp, &ready)?;
    loop {
        if let Ok(bytes) = fs::read(&done) {
            let _ = fs::remove_file(&done);
            let value: Value = serde_json::from_slice(&bytes)?;
            if let Some(error) = value["error"].as_str() {
                return Err(io::Error::other(error));
            }
            return Ok(value["ok"].as_str().map(PathBuf::from));
        }
        if lock.try_lock().is_ok() {
            // A normal --stop releases the lock just after publishing its reply.
            if done.exists() {
                let _ = lock.unlock();
                continue;
            }
            let _ = fs::remove_file(&ready);
            return Err(io::Error::other(
                "요청을 처리하기 전에 지켜보기가 종료됐습니다",
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}
fn cli() -> io::Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    let has = |s: &str| args.iter().any(|a| a == s);
    let paths = Paths::new()?;
    if has("--help") || has("-h") {
        println!("claude-session-share — Claude 데스크톱 세션 목록을 계정 폴더에 맞춥니다\n  claude-session-share                   계속 지켜보기\n  claude-session-share --once            한 번 맞추기\n  claude-session-share --once --backup   먼저 모든 계정 폴더 백업\n  claude-session-share --status          상태 보기\n  claude-session-share --backup-only     모든 계정 폴더를 백업하고 종료\n  claude-session-share --stop            상태 저장 후 지켜보기 종료\n데이터 폴더: {}",paths.data.display());
        return Ok(());
    }
    let boxed=platform::redirected_to(&paths.local).map(|p|format!("이 창에서는 AppData가 {p} 전용 폴더로 돌려집니다. 시작 단추에서 PowerShell을 따로 열어 다시 실행하세요."));
    if has("--status") {
        if let Some(text) = boxed {
            println!("(주의) {text}");
        }
        platform::print_status(
            &paths.data,
            &platform::load_state(&paths.data),
            &paths.roots(),
            env_ms("BATCH_MS", 300000),
        );
        return Ok(());
    }
    if let Some(text) = boxed {
        return Err(io::Error::other(text));
    }
    if has("--stop") && !paths.data.exists() {
        return Ok(());
    }
    fs::create_dir_all(&paths.data)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(paths.data.join(".watch.lock"))?;
    let backup_only = has("--backup-only");
    let once = has("--once") || backup_only;
    let stop = has("--stop");
    let backup = has("--backup");
    let pid = paths.data.join("claude-session-share.pid");
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::Error(e)) => return Err(e),
            Err(fs::TryLockError::WouldBlock) => {
                if platform::running_pid(&paths.data).is_none() {
                    // A one-shot run or a daemon still initializing owns the lock.
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
                if stop || once {
                    let dst = relay(
                        &paths.data,
                        if stop {
                            "stop"
                        } else if backup_only {
                            "backup-only"
                        } else if backup {
                            "backup"
                        } else {
                            "once"
                        },
                        &lock,
                    )?;
                    if let Some(p) = dst {
                        println!("맞추기 전 전체 백업: {}", p.display());
                    }
                    if stop {
                        lock.lock()?;
                    } else if !backup_only {
                        platform::print_status(
                            &paths.data,
                            &platform::load_state(&paths.data),
                            &paths.roots(),
                            env_ms("BATCH_MS", 300000),
                        );
                    }
                } else {
                    println!("이미 실행 중");
                }
                return Ok(());
            }
        }
    }
    if stop {
        return Ok(());
    }
    if let Some(other) = platform::running_pid(&paths.data) {
        if once {
            return Err(io::Error::other(format!(
                "기존 지켜보기(pid {other})를 종료한 뒤 한 번 맞추기를 실행하세요"
            )));
        }
        println!("이미 실행 중 (pid {other})");
        return Ok(());
    }
    if backup_only {
        if let Some(p) = backup::snapshot_all(&paths.data, &paths.roots())? {
            println!("맞추기 전 전체 백업: {}", p.display());
        }
        return Ok(());
    }
    let mut daemon = Daemon::new(paths, !once);
    if once {
        if let Some(p) = daemon.once(backup)? {
            println!("맞추기 전 전체 백업: {}", p.display());
        }
        platform::print_status(
            &daemon.paths.data,
            &daemon.state,
            &daemon.paths.roots(),
            daemon.batch,
        );
        Ok(())
    } else {
        fs::write(&pid, process::id().to_string())?;
        let result = daemon.run();
        let _ = fs::remove_file(pid);
        result
    }
}
fn main() {
    if let Err(e) = cli() {
        eprintln!("{e}");
        process::exit(1);
    }
}

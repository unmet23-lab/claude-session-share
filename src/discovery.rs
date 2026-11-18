use crate::{env_ms, mirror, platform::log, Family, TREES};
use chrono::{Local, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    env, fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Paths {
    pub home: PathBuf,
    pub local: PathBuf,
    pub roaming: PathBuf,
    pub data: PathBuf,
}

fn env_path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn user_home() -> io::Result<PathBuf> {
    env_path("USERPROFILE")
        .or_else(|| env_path("HOME"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "사용자 홈을 찾을 수 없습니다"))
}

pub fn data_dir() -> io::Result<&'static Path> {
    static DATA: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    if let Some(p) = DATA.get() {
        return Ok(p);
    }
    let resolved = if let Some(p) = env_path("CLAUDE_SESSION_SHARE_HOME") {
        p
    } else {
        let local = env_path("LOCALAPPDATA").unwrap_or(user_home()?.join("AppData/Local"));
        let standard = local.join("claude-session-share");
        let installed = standard.join("claude-session-share.exe");
        let installed_binary = env::current_exe()
            .ok()
            .and_then(|p| fs::canonicalize(p).ok())
            .zip(fs::canonicalize(installed).ok())
            .is_some_and(|(a, b)| lower(&a) == lower(&b));
        if installed_binary {
            match fs::read_to_string(standard.join("runtime-home.txt")) {
                Ok(raw) => {
                    let value = raw
                        .trim_start_matches('\u{feff}')
                        .trim_end_matches(['\r', '\n']);
                    if !Path::new(value).is_absolute() || value.contains(['\r', '\n', '\0']) {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "runtime-home.txt에 절대 경로 한 줄이 필요합니다",
                        ));
                    }
                    PathBuf::from(value)
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => standard,
                Err(e) => return Err(e),
            }
        } else {
            standard
        }
    };
    Ok(DATA.get_or_init(|| resolved))
}

impl Paths {
    pub fn new() -> io::Result<Self> {
        let home = user_home()?;
        let local = env_path("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData/Local"));
        let roaming = env_path("APPDATA").unwrap_or_else(|| home.join("AppData/Roaming"));
        let data = data_dir()?.to_owned();
        Ok(Self {
            home,
            local,
            roaming,
            data,
        })
    }
    pub fn roots(&self) -> Vec<PathBuf> {
        let outside = self.local.join("Claude-Data");
        let inside = self.local.join("Packages");
        let packages = |p: &Path| {
            names(p)
                .into_iter()
                .filter(|n| n.to_ascii_lowercase().starts_with("claude_"))
        };
        let mut candidates: Vec<_> = packages(&inside)
            .map(|n| {
                (
                    inside.join(&n).join("LocalCache/Roaming/Claude"),
                    n.to_lowercase(),
                    false,
                )
            })
            .collect();
        candidates.extend(packages(&outside).map(|n| (outside.join(&n), n.to_lowercase(), true)));
        candidates.push((self.roaming.join("Claude"), String::new(), false));
        let mut seen = HashSet::new();
        candidates.retain(|(p, _, _)| {
            TREES.iter().any(|t| real_dir(&p.join(t)))
                && seen.insert(lower(&fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        });
        let moved: HashSet<_> = candidates
            .iter()
            .filter(|c| c.2)
            .map(|c| c.1.clone())
            .collect();
        candidates
            .into_iter()
            .filter(|(p, pkg, out)| {
                *out || !moved.contains(pkg)
                    || !names(p)
                        .iter()
                        .any(|n| n.to_ascii_lowercase().starts_with(".user-data-left."))
            })
            .map(|c| c.0.components().collect())
            .collect()
    }
    pub fn main_log(&self) -> Option<PathBuf> {
        let mut cands = vec![
            self.local.join("Claude/logs/main.log"),
            self.roaming.join("Claude/logs/main.log"),
        ];
        cands.extend(self.roots().into_iter().map(|p| p.join("logs/main.log")));
        cands.retain(|p| p.is_file());
        cands.sort_by_key(|p| {
            std::cmp::Reverse(
                fs::metadata(p)
                    .and_then(|m| m.modified())
                    .unwrap_or(UNIX_EPOCH),
            )
        });
        cands.into_iter().next().map(|p| p.components().collect())
    }
    pub fn configs(&self) -> Vec<String> {
        let mut dirs = vec![self.home.clone(), self.home.join(".claude")];
        dirs.extend(env_path("CLAUDE_CONFIG_DIR"));
        if let Ok(extra) = env::var("CLAUDE_SESSION_SHARE_CONFIG_DIRS") {
            dirs.extend(
                extra
                    .split(';')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from),
            );
        }
        dirs.iter()
            .filter_map(|dir| {
                let data: Value =
                    serde_json::from_reader(fs::File::open(dir.join(".claude.json")).ok()?).ok()?;
                let acct = data["oauthAccount"]["accountUuid"].as_str()?;
                let org = data["oauthAccount"]["organizationUuid"].as_str()?;
                (uuid(acct) && uuid(org)).then(|| format!("{acct}/{org}").to_ascii_lowercase())
            })
            .collect()
    }
}

pub fn names(dir: &Path) -> Vec<String> {
    let mut result: Vec<_> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    result.sort();
    result
}
pub fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
pub fn valid_pair(s: &str) -> bool {
    s.split_once('/').is_some_and(|(a, b)| uuid(a) && uuid(b))
}
pub fn short(pair: &str) -> String {
    pair.split('/')
        .map(|s| s.chars().take(8).collect::<String>())
        .collect::<Vec<_>>()
        .join("/")
}
pub fn lower(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}
pub fn real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink() && !is_reparse(&m))
}
#[cfg(windows)]
fn is_reparse(m: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_reparse(_: &fs::Metadata) -> bool {
    false
}
pub fn pairs_from_dirs(tree: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for a in names(tree)
        .into_iter()
        .filter(|a| uuid(a) && real_dir(&tree.join(a)))
    {
        for o in names(&tree.join(&a)).into_iter().filter(|o| uuid(o)) {
            out.push(format!("{a}/{o}").to_ascii_lowercase());
        }
    }
    out
}
pub fn count_records(path: &Path) -> usize {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            n.starts_with("local_") && n.ends_with(".json")
        })
        .count()
}
pub fn stamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub struct FamilyScan {
    pub primary: Option<PathBuf>,
    pub dirs: Family,
    pub recreated: Vec<PathBuf>,
    retry: HashMap<PathBuf, u64>,
    ids: crate::identity::Ledger,
    pub error: Option<String>,
    previous_state: Option<SystemTime>,
}

enum Prepared {
    Existing,
    Created,
    Skipped,
}

fn ensure(
    dir: &Path,
    replaced: bool,
    before_create: impl FnOnce() -> io::Result<()>,
) -> io::Result<Prepared> {
    let Some(tree) = dir.parent().and_then(Path::parent) else {
        return Ok(Prepared::Skipped);
    };
    if !real_dir(tree) {
        return Ok(Prepared::Skipped);
    }
    if let Some(account) = dir.parent() {
        if fs::symlink_metadata(account).is_ok() && !real_dir(account) {
            return Ok(Prepared::Skipped);
        }
    }
    let link = match fs::symlink_metadata(dir) {
        Ok(m) if m.file_type().is_symlink() || is_reparse(&m) => true,
        Ok(m) if m.is_dir() => {
            if replaced {
                before_create()?;
                return Ok(Prepared::Created);
            }
            return Ok(Prepared::Existing);
        }
        Ok(_) => return Ok(Prepared::Skipped),
        Err(e) if e.kind() == io::ErrorKind::NotFound => false,
        Err(e) => return Err(e),
    };
    before_create()?;
    // Remove only the junction entry after the on-disk deletion baseline has been cleared.
    if link {
        fs::remove_dir(dir)?;
    }
    fs::create_dir_all(dir)?;
    Ok(Prepared::Created)
}
fn synced(tree: &Value, path: &Path) -> bool {
    tree.as_array().is_some_and(|v| {
        v.iter()
            .filter_map(Value::as_str)
            .any(|s| lower(Path::new(s)) == lower(path))
    })
}
fn forget_synced(state: &mut Value, tree: &str, path: &Path) {
    let key = lower(path);
    if let Some(a) = state["synced"].get_mut(tree).and_then(Value::as_array_mut) {
        a.retain(|s| !s.as_str().is_some_and(|p| lower(Path::new(p)) == key));
    }
    // A replacement's empty task list cannot delete tasks read by the previous directory.
    if let Some(dirs) = state["tasks"]
        .get_mut(tree)
        .and_then(|t| t.get_mut("dirs"))
        .and_then(Value::as_object_mut)
    {
        dirs.remove(&key);
    }
}
impl FamilyScan {
    pub fn new(data: &Path) -> Self {
        let previous_state = fs::metadata(data.join("claude-session-share.json"))
            .and_then(|m| m.modified())
            .ok();
        Self {
            previous_state,
            ids: crate::identity::Ledger::new(data),
            primary: None,
            dirs: Family::new(),
            recreated: Vec::new(),
            retry: HashMap::new(),
            error: None,
        }
    }
    fn failed(&mut self, dir: &Path, error: io::Error) {
        let msg = format!("{} 준비 실패: {error}", dir.display());
        log(&msg);
        self.error = Some(msg);
    }
    pub fn refresh(
        &mut self,
        paths: &Paths,
        state: &mut Value,
        logged: Option<&HashSet<String>>,
        engine: &mut mirror::Engine,
        now: u64,
    ) -> bool {
        self.error = None;
        self.recreated.clear();
        let roots = paths.roots();
        // No targets remain during a whole-root move. Never feed their absence to the deletion algorithm.
        if roots.is_empty() {
            self.dirs.clear();
            self.primary = None;
            return false;
        }
        let mut primary = &roots[0];
        let mut best = None;
        for root in &roots {
            let t = root.join(TREES[0]);
            let n = pairs_from_dirs(&t)
                .iter()
                .map(|k| count_records(&t.join(k)))
                .sum::<usize>();
            if best.is_none_or(|v| n > v) {
                best = Some(n);
                primary = root;
            }
        }
        self.primary = Some(primary.clone());
        let mut changed = false;
        let stamp_name = Local::now().format("%Y%m%d-%H%M%S-parked").to_string();
        let known: Vec<String> = state["known"]
            .as_object()
            .into_iter()
            .flat_map(|v| v.keys())
            .filter(|k| valid_pair(k))
            .cloned()
            .collect();
        let min_age = env_ms("PARK_MIN_AGE_MS", 3600000);
        for tree in TREES {
            let mut dirs = Vec::new();
            let mut present = HashSet::new();
            for r in &roots {
                let t = r.join(tree);
                if !real_dir(&t) {
                    continue;
                }
                for key in pairs_from_dirs(&t) {
                    present.insert(key.clone());
                    dirs.push((t.join(&key), key));
                }
            }
            for key in &known {
                if !present.contains(key) && real_dir(&primary.join(tree)) {
                    dirs.push((primary.join(tree).join(key), key.clone()));
                }
                if let Some(obj) = state["parked"].get_mut(tree).and_then(Value::as_object_mut) {
                    changed |= obj.remove(key).is_some();
                }
            }
            let mut ok = Vec::new();
            for (raw, key) in dirs {
                let d: PathBuf = raw.components().collect();
                let known = !state["known"][&key].is_null();
                let transient = !state["transient"][&key].is_null();
                let pending = state["pendingInit"]["key"].as_str() == Some(&key);
                let existed = real_dir(&d);
                let previous_id = match self.ids.get(&d) {
                    Ok(v) => v,
                    Err(e) => {
                        self.failed(&d, e);
                        continue;
                    }
                };
                let before = if existed {
                    match crate::identity::observe(&d) {
                        Ok(v) => Some(v),
                        Err(e) => {
                            self.failed(&d, e);
                            continue;
                        }
                    }
                } else {
                    None
                };
                let replaced = before.is_some_and(|info| match previous_id {
                    Some(id) => id != info.id,
                    None => info
                        .birth
                        .zip(self.previous_state)
                        .is_some_and(|(created, saved)| created > saved),
                });
                let can_park = existed
                    && !replaced
                    && logged.is_some_and(|l| !l.contains(&key))
                    && !known
                    && !pending
                    && state["active"].as_str() != Some(&key)
                    && now >= *self.retry.get(&d).unwrap_or(&0)
                    && (synced(&state["synced"][tree], &d)
                        || (transient && mirror::nothing_to_merge(&d)))
                    && fs::metadata(&d)
                        .and_then(|m| m.created())
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .is_some_and(|t| now.saturating_sub(t.as_millis() as u64) >= min_age);
                if can_park {
                    let to: PathBuf = paths
                        .data
                        .join("claude-session-backups")
                        .join(&stamp_name)
                        .join(tree)
                        .join(&key)
                        .components()
                        .collect();
                    let moved =
                        fs::create_dir_all(to.parent().unwrap()).and_then(|_| fs::rename(&d, &to));
                    match moved {
                        Ok(()) => {
                            state["parked"][tree][&key] = json!({"at":stamp(),"to":to});
                            forget_synced(state, tree, &d);
                            engine.forget(&d);
                            changed = true;
                            log(&format!(
                                "{}: 로그인 기록이 없는 짝 폴더라 쉬게 함({tree}, 옮긴 곳 {})",
                                short(&key),
                                to.display()
                            ));
                            continue;
                        }
                        Err(e) => {
                            self.retry.insert(d.clone(), now + 3600000);
                            log(&format!("{}: 쉬게 하지 못해 그대로 맞춤: {e}", short(&key)));
                        }
                    }
                }
                if logged.is_some()
                    && !known
                    && (pending || transient)
                    && existed
                    && mirror::nothing_to_merge(&d)
                {
                    continue;
                }
                let mut disarm = || {
                    // A crash after mkdir or midway through refill must never turn the
                    // still-missing files into deletions. Repeat this durable write even
                    // after a failed earlier attempt already removed the in-memory entry.
                    engine.forget(&d);
                    forget_synced(state, tree, &d);
                    crate::platform::write_state(&paths.data, state)
                };
                let admitted = (|| -> io::Result<Option<bool>> {
                    let prepared = ensure(&d, replaced, &mut disarm)?;
                    if matches!(prepared, Prepared::Skipped) {
                        return Ok(None);
                    }
                    let actual = crate::identity::observe(&d)?;
                    let mut rebound = matches!(prepared, Prepared::Created);
                    if !rebound && !before.is_some_and(|v| v.id == actual.id) {
                        // The entry changed again between inspection and opening the directory.
                        disarm()?;
                        rebound = true;
                    }
                    self.ids.record(&d, actual.id)?;
                    Ok(Some(rebound))
                })();
                match admitted {
                    Ok(Some(rebound)) => {
                        if rebound {
                            self.recreated.push(d.clone());
                        }
                        ok.push(d);
                    }
                    Ok(None) => {}
                    Err(e) => self.failed(&d, e),
                }
            }
            ok.sort();
            self.dirs.insert(tree.to_string(), ok);
        }
        if self.error.is_some() {
            self.dirs.clear();
        }
        changed
    }
}

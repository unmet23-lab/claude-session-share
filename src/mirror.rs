use crate::platform::log;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    ffi::OsStr,
    fs::{self, File, FileTimes},
    io,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(crate) const REGISTRY: &str = "scheduled-tasks.json";
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

pub(crate) fn temp_path(dir: &Path) -> PathBuf {
    dir.join(format!(
        ".mirror-{}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ))
}

pub(crate) fn temp_name(name: &str) -> bool {
    if name.starts_with('.') || name.to_ascii_lowercase().ends_with(".tmp") {
        return true;
    }
    name.rsplit_once(".tmp-").is_some_and(|(_, tail)| {
        let b = tail.as_bytes();
        b.len() == 16
            && b[..10].iter().all(u8::is_ascii_digit)
            && b[10..]
                .iter()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
    })
}

pub(crate) fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

pub(crate) fn real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !is_link(&m))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Stamp {
    pub m: i64,
    pub s: u64,
}
impl Stamp {
    pub fn read(path: &Path) -> io::Result<Self> {
        Self::from_meta(&fs::metadata(path)?)
    }
    pub(crate) fn from_meta(meta: &fs::Metadata) -> io::Result<Self> {
        let modified = meta.modified()?;
        let ns = match modified.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_nanos() as i128,
            Err(e) => -(e.duration().as_nanos() as i128),
        };
        Ok(Self {
            m: (ns + 500_000).div_euclid(1_000_000) as i64,
            s: meta.len(),
        })
    }
    fn parse(v: &Value) -> Option<Self> {
        Some(Self {
            m: v["m"].as_i64()?,
            s: v["s"].as_u64()?,
        })
    }
    fn json(self) -> Value {
        json!({"m":self.m,"s":self.s})
    }
    fn newer(self, other: Option<Self>) -> bool {
        other.is_none_or(|b| self.m > b.m || (self.m == b.m && self.s != b.s))
    }
    fn time(self) -> SystemTime {
        let d = Duration::from_millis(self.m.unsigned_abs());
        if self.m >= 0 {
            UNIX_EPOCH + d
        } else {
            UNIX_EPOCH - d
        }
    }
}

pub(crate) fn copy_stamped(src: &Path, dst: &Path, stamp: Stamp) -> io::Result<()> {
    fs::copy(src, dst)?;
    let times = FileTimes::new()
        .set_accessed(stamp.time())
        .set_modified(stamp.time());
    let mut attr = File::options();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // 복사본이 읽기 전용이어도 시각을 기록할 권한만 요청하면 된다.
        attr.access_mode(0x100); // FILE_WRITE_ATTRIBUTES
    }
    #[cfg(not(windows))]
    attr.read(true);
    attr.open(dst)?.set_times(times)?;
    if Stamp::read(src)? != stamp {
        return Err(io::Error::other("복사 중에 원본이 바뀜"));
    }
    Ok(())
}

type Manifest = BTreeMap<String, Stamp>;
fn walk(
    dir: &Path,
    prefix: &str,
    prev: Option<&Manifest>,
    backup: bool,
    out: &mut Manifest,
) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let e = entry?;
        let name = e.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| io::Error::other("읽을 수 없는 파일 이름"))?;
        if temp_name(name) || (!backup && prefix.is_empty() && name == REGISTRY) {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        let typ = e.file_type()?;
        if typ.is_symlink() {
            continue;
        }
        if !backup && typ.is_file() && name.starts_with("deleted_") {
            if let Some(st) = prev.and_then(|m| m.get(&rel)) {
                out.insert(rel, *st);
                continue;
            }
        }
        let meta = e.metadata()?;
        if is_link(&meta) {
            continue;
        }
        if meta.is_dir() {
            walk(&e.path(), &rel, prev, backup, out)?;
        } else if meta.is_file() {
            out.insert(rel, Stamp::from_meta(&meta)?);
        }
    }
    Ok(())
}

fn scan(dir: &Path, prev: Option<&Manifest>, backup: bool) -> io::Result<Manifest> {
    let mut out = Manifest::new();
    walk(dir, "", prev, backup, &mut out)?;
    Ok(out)
}

pub(crate) fn backup_files(dir: &Path) -> io::Result<BTreeMap<String, Stamp>> {
    scan(dir, None, true)
}
pub fn nothing_to_merge(dir: &Path) -> bool {
    scan(dir, None, false).is_ok_and(|files| files.is_empty())
}

pub fn file_count(dir: &Path) -> usize {
    scan(dir, None, false).map_or(0, |s| s.len())
}
pub(crate) fn dir_key(dir: &Path) -> String {
    crate::discovery::lower(dir)
}
pub(crate) fn pair(dir: &Path) -> String {
    let name = |d: &Path| {
        d.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
    };
    format!(
        "{}/{}",
        dir.parent().map_or_else(String::new, name),
        name(dir)
    )
}

fn checked_path(dir: &Path, rel: &str, create_parents: bool) -> io::Result<PathBuf> {
    if !real_dir(dir) {
        return Err(io::Error::other("짝 폴더가 없어짐"));
    }
    let mut result = dir.to_path_buf();
    let mut parts = Path::new(rel).components().peekable();
    if parts.peek().is_none() {
        return Err(io::Error::other("빈 파일 이름"));
    }
    while let Some(part) = parts.next() {
        let Component::Normal(name) = part else {
            return Err(io::Error::other("상대 경로가 아님"));
        };
        result.push(name);
        match fs::symlink_metadata(&result) {
            Ok(meta) if is_link(&meta) => return Err(io::Error::other("연결 경로는 건너뜀")),
            Ok(meta) if parts.peek().is_some() && !meta.is_dir() => {
                return Err(io::Error::other("하위 폴더 자리에 파일이 있음"))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if create_parents && parts.peek().is_some() {
                    fs::create_dir(&result)?;
                }
            }
            Err(e) => return Err(e),
            _ => {}
        }
    }
    Ok(result)
}

fn stamp_or_absent(path: &Path) -> io::Result<Option<Stamp>> {
    match fs::symlink_metadata(path) {
        Ok(m) if is_link(&m) || !m.is_file() => Err(io::Error::other("일반 파일이 아님")),
        Ok(m) => Stamp::from_meta(&m).map(Some),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn copy_file(
    from: &Path,
    to: &Path,
    rel: &str,
    new: Stamp,
    expected: Option<Stamp>,
) -> io::Result<()> {
    let src = checked_path(from, rel, false)?;
    let dst = checked_path(to, rel, true)?;
    let tmp = temp_path(dst.parent().unwrap());
    let result = (|| {
        copy_stamped(&src, &tmp, new)?;
        if stamp_or_absent(&dst)? != expected {
            return Err(io::Error::other("복사 직전에 대상이 바뀜"));
        }
        fs::rename(&tmp, &dst)
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

#[derive(Default)]
struct Tree {
    manifests: HashMap<PathBuf, Manifest>,
    full: bool,
}

#[derive(Default)]
pub struct Engine {
    trees: HashMap<String, Tree>,
    own: HashMap<PathBuf, (Option<Stamp>, Instant)>,
}

#[derive(Default)]
pub struct Outcome {
    pub changed: bool,
    pub failed: usize,
    pub roots_moved: bool,
    pub scanned: Vec<PathBuf>,
    pub written: Vec<PathBuf>,
}

impl Engine {
    pub fn expire_own(&mut self) {
        self.own
            .retain(|_, (_, at)| at.elapsed() < Duration::from_secs(10));
        if self.own.capacity() > self.own.len().saturating_mul(4).max(128) {
            self.own.shrink_to_fit();
        }
    }

    pub fn forget(&mut self, dir: &Path) {
        for tree in self.trees.values_mut() {
            if tree.manifests.remove(dir).is_some() {
                tree.full = false;
            }
        }
        self.own.retain(|p, _| !p.starts_with(dir));
    }
    pub fn watch_event(&self, tree: &str, dir: &Path, rel: &Path, state: &Value) -> Option<bool> {
        let name = rel.file_name().and_then(OsStr::to_str);
        if name.is_some_and(temp_name) || rel == Path::new(REGISTRY) {
            return None;
        }
        if rel.as_os_str().is_empty() {
            return Some(true);
        }
        let path = dir.join(rel);
        if path.is_dir() {
            return None;
        }
        let stamp = Stamp::read(&path).ok();
        if let Some((own, at)) = self.own.get(&path) {
            if at.elapsed() < Duration::from_secs(10) && stamp == *own {
                return None;
            }
        }
        let key = rel.to_string_lossy().replace('\\', "/");
        Some(stamp.is_none() || state["union"][tree].get(key).is_none())
    }

    pub fn sync(
        &mut self,
        tree: &str,
        dirs: &[PathBuf],
        state: &mut Value,
        dirty: &HashSet<PathBuf>,
        full: bool,
    ) -> io::Result<Outcome> {
        let mut result = Outcome::default();
        self.own
            .retain(|_, (_, at)| at.elapsed() < Duration::from_secs(10));
        let cache = self.trees.entry(tree.to_owned()).or_default();
        cache.manifests.retain(|dir, _| dirs.contains(dir));
        let mut present = Vec::new();
        for d in dirs {
            if real_dir(d) {
                present.push(d.clone());
            } else {
                cache.manifests.remove(d);
                result.roots_moved = true;
                result.scanned.push(d.clone());
            }
        }
        let full = full || !cache.full || present.iter().any(|d| !cache.manifests.contains_key(d));
        let selected: Vec<_> = present
            .iter()
            .filter(|d| full || dirty.contains(*d))
            .collect();
        if selected.is_empty() {
            return Ok(result);
        }
        if std::env::var("CLAUDE_SESSION_SHARE_VERBOSE").as_deref() == Ok("1") {
            let names: Vec<_> = selected
                .iter()
                .map(|d| {
                    pair(d)
                        .split('/')
                        .map(|s| s.chars().take(8).collect::<String>())
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .collect();
            log(&format!(
                "훑기 {tree}: {}곳 ({}){}",
                selected.len(),
                names.join(" "),
                if full { " 전체" } else { "" }
            ));
        }

        let old_dirs = state["synced"][tree]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let synced: HashSet<_> = old_dirs
            .iter()
            .filter_map(Value::as_str)
            .map(|s| dir_key(Path::new(s)))
            .collect();
        if !state["union"][tree].is_object() {
            state["union"][tree] = json!({});
        }
        let union = state["union"][tree].as_object_mut().unwrap();
        let previously = |r: &str| union.get(r).and_then(Stamp::parse);
        let mut upserts: BTreeMap<String, (Stamp, PathBuf)> = BTreeMap::new();
        let mut deletes = BTreeSet::new();
        let mut scans = HashMap::new();
        for &dir in &selected {
            let prev = cache.manifests.get(dir);
            let found = match scan(dir, prev, false) {
                Ok(v) if real_dir(dir) => v,
                _ => {
                    result.failed += 1;
                    result.roots_moved |= !real_dir(dir);
                    cache.full = false;
                    log(&format!(
                        "{tree}: 짝 폴더를 다 읽지 못해 삭제와 복사를 미룸"
                    ));
                    return Ok(result);
                }
            };
            for (r, &s) in &found {
                let old = prev
                    .and_then(|m| m.get(r))
                    .copied()
                    .or_else(|| previously(r));
                if s.newer(old) && upserts.get(r).is_none_or(|(u, _)| s.m > u.m) {
                    upserts.insert(r.clone(), (s, dir.clone()));
                }
            }
            if let Some(m) = prev {
                deletes.extend(m.keys().filter(|r| !found.contains_key(*r)).cloned());
            } else if synced.contains(&dir_key(dir)) {
                deletes.extend(union.keys().filter(|r| !found.contains_key(*r)).cloned());
            }
            scans.insert(dir.clone(), found);
        }

        if full {
            let mut seen = BTreeMap::new();
            for d in &present {
                for (r, &s) in &scans[d] {
                    let choice = seen.entry(r.as_str()).or_insert((s, d));
                    if s.m > choice.0.m {
                        *choice = (s, d);
                    }
                }
            }
            for (r, (s, src)) in seen {
                if upserts.contains_key(r) || deletes.contains(r) {
                    continue;
                }
                if present.iter().any(|d| s.newer(scans[d].get(r).copied())) {
                    upserts.insert(r.to_owned(), (s, src.clone()));
                }
            }
        }
        for rel in upserts.keys() {
            deletes.remove(rel);
        }
        if tree == "claude-code-sessions" {
            let tombs: HashSet<_> = scans
                .values()
                .flat_map(|m| m.keys())
                .chain(union.keys())
                .filter_map(|n| n.strip_prefix("deleted_"))
                .collect();
            if !tombs.is_empty() {
                upserts.retain(|r, (_, d)| {
                    if r.starts_with("local_")
                        && r.ends_with(".json")
                        && r.len() > "local_.json".len()
                        && !r.contains('/')
                    {
                        let file = fs::File::open(d.join(r)).ok();
                        let j: Option<Value> = file
                            .and_then(|f| serde_json::from_reader(std::io::BufReader::new(f)).ok());
                        if j.as_ref()
                            .and_then(|v| v["cliSessionId"].as_str())
                            .is_some_and(|id| tombs.contains(id))
                        {
                            deletes.insert(r.clone());
                            return false;
                        }
                    }
                    true
                });
            }
        }

        result.scanned.extend(selected.iter().map(|d| (*d).clone()));
        cache.manifests.extend(scans);
        let mut written = BTreeSet::new();
        let mut failed_dirs = HashSet::new();
        let (mut copied, mut removed) = (0usize, 0usize);
        for (rel, (st, src)) in &upserts {
            for d in &present {
                if d == src {
                    continue;
                }
                let cur = cache.manifests[d].get(rel).copied();
                if !st.newer(cur) {
                    continue;
                }
                match copy_file(src, d, rel, *st, cur) {
                    Ok(()) => {
                        copied += 1;
                        self.own.insert(d.join(rel), (Some(*st), Instant::now()));
                        written.insert(d.clone());
                        cache.manifests.get_mut(d).unwrap().insert(rel.clone(), *st);
                    }
                    Err(e) => {
                        result.failed += 1;
                        result.roots_moved |= !real_dir(d);
                        failed_dirs.insert(dir_key(d));
                        log(&format!("{tree}/{rel} 복사 실패: {e}"));
                    }
                }
            }
            if union.get(rel).and_then(Stamp::parse) != Some(*st) {
                union.insert(rel.clone(), st.json());
                result.changed = true;
            }
        }
        for rel in &deletes {
            let mut success = true;
            if rel != REGISTRY {
                for d in &present {
                    let current = cache.manifests[d].get(rel).copied();
                    let removed_file = (|| {
                        let p = checked_path(d, rel, false)?;
                        let Some(actual) = stamp_or_absent(&p)? else {
                            return Ok(false);
                        };
                        if Some(actual) != current {
                            return Err(io::Error::other("삭제 직전에 대상이 바뀜"));
                        }
                        fs::remove_file(p)?;
                        Ok(true)
                    })();
                    match removed_file {
                        Ok(true) => {
                            removed += 1;
                            self.own.insert(d.join(rel), (None, Instant::now()));
                            written.insert(d.clone());
                            cache.manifests.get_mut(d).unwrap().remove(rel);
                        }
                        Ok(false) => {}
                        Err(e) => {
                            success = false;
                            result.failed += 1;
                            result.roots_moved |= !real_dir(d);
                            log(&format!("{tree}/{rel} 삭제 실패: {e}"));
                        }
                    }
                }
            }
            if success && union.remove(rel).is_some() {
                result.changed = true;
            }
        }
        if result.failed > 0 {
            cache.full = false;
            cache.manifests.clear(); // 저장된 union으로 다시 대조해 아직 못 지운 파일도 재시도한다.
        } else {
            cache.full = true;
        }
        let new_dirs: Vec<_> = if full && result.failed == 0 {
            present
                .iter()
                .map(|p| json!(p.to_string_lossy().replace('/', "\\")))
                .collect()
        } else {
            old_dirs
                .iter()
                .filter(|p| {
                    !p.as_str()
                        .is_some_and(|v| failed_dirs.contains(&dir_key(Path::new(v))))
                })
                .cloned()
                .collect()
        };
        let after: HashSet<_> = new_dirs
            .iter()
            .filter_map(Value::as_str)
            .map(|s| dir_key(Path::new(s)))
            .collect();
        if synced != after || !state["synced"][tree].is_array() {
            state["synced"][tree] = Value::Array(new_dirs);
            result.changed = true;
        }
        result.written = written.into_iter().collect();
        if copied + removed + result.failed > 0 {
            let names: Vec<_> = upserts
                .keys()
                .map(|r| format!("+{r}"))
                .chain(deletes.iter().map(|r| format!("-{r}")))
                .collect();
            let suffix = if names.len() <= 5 {
                format!(" [{}]", names.join(" "))
            } else {
                String::new()
            };
            log(&format!(
                "{tree}: {}곳 확인, {copied}개 복사, {removed}개 삭제, {}개 실패{suffix}",
                selected.len(),
                result.failed
            ));
        }
        Ok(result)
    }
}

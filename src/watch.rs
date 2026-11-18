use crate::{discovery::real_dir, mirror::Engine, platform::log, Family};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};

pub struct Watches {
    watcher: Option<RecommendedWatcher>,
    rx: mpsc::Receiver<notify::Result<Event>>,
    dirs: HashMap<PathBuf, String>,
    times: HashMap<PathBuf, Option<DirInfo>>,
    pub dirty: HashSet<PathBuf>,
    pub urgent: bool,
    pub moved: bool,
    pub since: Option<u64>,
}
use crate::identity::DirInfo;
fn dir_times(d: &Path) -> Option<DirInfo> {
    crate::identity::observe(d).ok()
}
impl Watches {
    pub fn new(enabled: bool) -> Self {
        let (tx, rx) = mpsc::channel();
        let watcher = if enabled {
            match notify::recommended_watcher(move |event| {
                let _ = tx.send(event);
            }) {
                Ok(w) => Some(w),
                Err(e) => {
                    log(&format!("폴더 감시 시작 실패: {e}"));
                    None
                }
            }
        } else {
            None
        };
        Self {
            watcher,
            rx,
            dirs: HashMap::new(),
            times: HashMap::new(),
            dirty: HashSet::new(),
            urgent: false,
            moved: false,
            since: None,
        }
    }
    pub fn refresh(&mut self, family: &Family, recreated: &[PathBuf]) {
        let want: HashMap<_, _> = family
            .iter()
            .flat_map(|(tree, v)| v.iter().map(|d| (d.clone(), tree.clone())))
            .collect();
        self.times.retain(|d, _| want.contains_key(d));
        self.dirty.retain(|d| want.contains_key(d));
        if let Some(w) = &mut self.watcher {
            self.dirs.retain(|d, _| {
                if want.contains_key(d) && !recreated.contains(d) {
                    true
                } else {
                    let _ = w.unwatch(d);
                    false
                }
            });
            for (d, t) in &want {
                if !self.dirs.contains_key(d) {
                    match w.watch(d, RecursiveMode::Recursive) {
                        Ok(()) => {
                            self.dirs.insert(d.clone(), t.clone());
                        }
                        Err(e) => log(&format!("{} 감시 실패: {e}", d.display())),
                    }
                }
            }
        }
        for d in want.keys() {
            self.times.entry(d.clone()).or_insert_with(|| dir_times(d));
        }
    }
    fn mark(&mut self, d: PathBuf, urgent: bool, now: u64) {
        self.dirty.insert(d);
        self.urgent |= urgent;
        self.since.get_or_insert(now);
    }
    pub fn poll(&mut self, now: u64) {
        let mut changed = Vec::new();
        for (d, old) in &mut self.times {
            let new = dir_times(d);
            if *old != new {
                if new.as_ref().map(|s| s.id) != old.as_ref().map(|s| s.id) {
                    self.moved = true;
                }
                changed.push(d.clone());
                *old = new;
            }
        }
        for d in changed {
            self.mark(d, false, now);
        }
    }
    pub fn updated(&mut self, dirs: Vec<PathBuf>) {
        for d in dirs {
            let new = dir_times(&d);
            if let (Some(Some(old)), Some(stamp)) = (self.times.get_mut(&d), new) {
                old.modified = stamp.modified;
            }
        }
    }
    pub fn wait(&mut self, duration: Duration, engine: &Engine, state: &Value) {
        if self.watcher.is_none() {
            std::thread::sleep(duration);
            return;
        }
        if let Ok(e) = self.rx.recv_timeout(duration) {
            self.event(e, engine, state, crate::now());
            for _ in 0..2048 {
                let Ok(e) = self.rx.try_recv() else { break };
                self.event(e, engine, state, crate::now());
            }
        }
    }
    fn event(&mut self, event: notify::Result<Event>, engine: &Engine, state: &Value, now: u64) {
        let ev = match event {
            Ok(e) if !e.need_rescan() && !e.paths.is_empty() => e,
            _ => {
                for d in self.dirs.keys().cloned().collect::<Vec<_>>() {
                    self.mark(d, true, now);
                }
                self.moved = true;
                return;
            }
        };
        for p in &ev.paths {
            let Some((d, tree)) = self.dirs.iter().find(|(d, _)| p.starts_with(d)) else {
                continue;
            };
            let rel = p.strip_prefix(d).unwrap();
            if rel.as_os_str().is_empty() {
                if !real_dir(d) {
                    self.moved = true;
                }
                self.mark(d.clone(), true, now);
            } else if let Some(urgent) = engine.watch_event(tree, d, rel, state) {
                self.mark(d.clone(), urgent, now);
            }
        }
    }
}

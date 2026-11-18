use crate::{
    discovery::{self, Paths},
    env_ms,
    platform::log,
};
use chrono::{Local, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::LazyLock,
};

static INIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[LocalSessionManager\] Initialization succeeded — accountId=([0-9a-f-]{36}), orgId=([0-9a-f-]{36})(?:, existingSessions=(\d+))?").unwrap()
});
static LOAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:Loaded (\d+) persisted sessions from |\[LocalSessionManager\] Session storage directory does not exist yet, skipping load: ).*?[\\/]([^\\/]+)[\\/]([0-9a-f-]{36})[\\/]([0-9a-f-]{36})(?:\s|$)").unwrap()
});
const LOGOUT: &str = "[LocalSessionManager] Account logged out";

#[derive(Clone)]
struct Login {
    key: Option<String>,
    time: Option<i64>,
}

fn timestamp(line: &str) -> Option<i64> {
    let s = line.get(..19)?;
    let t = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S"))
        .ok()?;
    Local
        .from_local_datetime(&t)
        .earliest()
        .map(|t| t.timestamp_millis())
}
fn login(line: &str) -> Option<(Login, Value)> {
    if line.contains(LOGOUT) {
        return Some((
            Login {
                key: None,
                time: timestamp(line),
            },
            Value::Null,
        ));
    }
    if !line.contains("Initialization succeeded") {
        return None;
    }
    let c = INIT.captures(line)?;
    if !discovery::uuid(&c[1]) || !discovery::uuid(&c[2]) {
        return None;
    }
    let existing = c.get(3).and_then(|m| m.as_str().parse::<u64>().ok());
    Some((
        Login {
            key: Some(format!("{}/{}", &c[1], &c[2])),
            time: timestamp(line),
        },
        json!(existing),
    ))
}
struct Classified {
    real: HashSet<String>,
    transient: Vec<(String, i64, i64)>,
    pending: Value,
}
fn classify(seq: &[Login], now: u64) -> Classified {
    let limit = env_ms("TRANSIENT_MS", 30000) as i64;
    let mut result = Classified {
        real: HashSet::new(),
        transient: Vec::new(),
        pending: Value::Null,
    };
    for (i, e) in seq.iter().enumerate() {
        let Some(k) = &e.key else { continue };
        if let Some(ts) = e.time {
            if let Some(next) = seq.get(i + 1) {
                if let (Some(next_key), Some(next_ts)) = (&next.key, next.time) {
                    let gap = next_ts - ts;
                    if k != next_key && (0..=limit).contains(&gap) {
                        result.transient.push((k.clone(), ts, gap));
                        continue;
                    }
                }
            } else if (now as i64) - ts < limit {
                result.pending = json!({"key":k,"ts":ts});
                continue;
            }
        }
        result.real.insert(k.clone());
    }
    result
}
fn all_logins(main: &Path, now: u64) -> (HashSet<String>, HashSet<String>) {
    let Some(dir) = main.parent() else {
        return Default::default();
    };
    let mut files: Vec<_> = discovery::names(dir)
        .into_iter()
        .filter_map(|name| {
            let lo = name.to_ascii_lowercase();
            let suffix = lo.strip_prefix("main")?.strip_suffix(".log")?;
            let index = if suffix.is_empty() {
                -1
            } else {
                suffix.parse::<i32>().ok()?
            };
            Some((index, name))
        })
        .collect();
    files.sort_by_key(|(i, _)| std::cmp::Reverse(*i));
    let mut seq = Vec::new();
    for (_, n) in files {
        let Ok(f) = File::open(dir.join(n)) else {
            continue;
        };
        let mut reader = BufReader::new(f);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Some((e, _)) = login(&String::from_utf8_lossy(&buf)) {
                        seq.push(e)
                    }
                }
            }
        }
    }
    let real = classify(&seq, now).real;
    (real, seq.into_iter().filter_map(|e| e.key).collect())
}

#[derive(Default)]
pub struct Events {
    pub inits: Vec<String>,
    pub empty: Vec<String>,
    pub logout: bool,
    pub logged: bool,
    pub new_pair: bool,
    pub urgent: bool,
}
#[derive(Default)]
pub struct SessionLogs {
    main: Option<PathBuf>,
    pub logged_pairs: Option<HashSet<String>>,
}
fn read_events(
    main: &Path,
    state: &mut Value,
    seq: &mut Vec<Login>,
    out: &mut Events,
) -> io::Result<()> {
    let mut f = File::open(main)?;
    let size = f.metadata()?.len();
    let path = main.to_string_lossy();
    let mut offset = state["logOffset"].as_u64().unwrap_or(0);
    if state["logPath"].as_str() != Some(path.as_ref()) || offset > size {
        offset = 0;
        state["logPath"] = json!(path);
        state["logOffset"] = json!(0);
    }
    if offset == size {
        return Ok(());
    }
    let start = offset.max(size.saturating_sub(8 * 1024 * 1024));
    f.seek(SeekFrom::Start(start))?;
    let mut data = Vec::new();
    f.take(size - start).read_to_end(&mut data)?;
    let Some(end) = data.iter().rposition(|&c| c == b'\n') else {
        return Ok(());
    };
    state["logOffset"] = json!(start + end as u64 + 1);
    for line in String::from_utf8_lossy(&data[..end]).lines() {
        if let Some((event, existing)) = login(line) {
            if let Some(k) = &event.key {
                state["existing"][k] = existing;
                out.inits.push(k.clone());
                out.logout = false;
            } else {
                out.logout = true;
            }
            seq.push(event);
            out.logged = true;
        } else if line.contains("persisted sessions from ") || line.contains("skipping load: ") {
            if let Some(c) = LOAD.captures(line) {
                if !discovery::uuid(&c[3]) || !discovery::uuid(&c[4]) {
                    continue;
                }
                out.logged = true;
                let k = format!("{}/{}", &c[3], &c[4]);
                if c.get(1).is_none_or(|m| m.as_str().parse::<u64>() == Ok(0))
                    && &c[2] == "claude-code-sessions"
                    && state["existing"][&k].as_u64().unwrap_or(0) == 0
                {
                    out.empty.push(k);
                }
            }
        }
    }
    Ok(())
}
fn learn(state: &mut Value, k: &str, ev: &mut Events) {
    if state["known"][k].is_null() {
        state["known"][k] = json!(discovery::stamp());
        ev.new_pair = true;
        ev.urgent = true;
    }
}
impl SessionLogs {
    pub fn read(&mut self, paths: &Paths, state: &mut Value, now: u64, scan: bool) -> Events {
        if scan {
            self.main = paths.main_log();
        }
        let mut ev = Events::default();
        let mut seq = Vec::new();
        if let Some(key) = state["pendingInit"]["key"].as_str() {
            seq.push(Login {
                key: Some(key.to_string()),
                time: state["pendingInit"]["ts"].as_i64(),
            });
        }
        let found = self
            .main
            .as_ref()
            .is_some_and(|p| read_events(p, state, &mut seq, &mut ev).is_ok());
        let configs = if scan || (found && self.logged_pairs.is_none()) {
            paths.configs()
        } else {
            Vec::new()
        };
        if found && self.logged_pairs.is_none() {
            let (real, all) = all_logins(self.main.as_ref().unwrap(), now);
            for k in &real {
                learn(state, k, &mut ev);
            }
            let demoted = state["known"]
                .as_object()
                .into_iter()
                .flat_map(|o| o.keys())
                .filter(|k| {
                    all.contains(*k)
                        && !real.contains(*k)
                        && !configs.contains(k)
                        && state["active"].as_str() != Some(k)
                        && state["pendingInit"]["key"].as_str() != Some(k)
                })
                .cloned()
                .collect::<Vec<_>>();
            if !demoted.is_empty() {
                for k in &demoted {
                    state["known"].as_object_mut().unwrap().remove(k);
                    state["transient"][k] = json!(discovery::stamp());
                }
                ev.new_pair = true;
                ev.urgent = true;
                log(&format!(
                    "앱이 계정을 바꾸며 몇 초만 거친 짝 {}곳을 로그인 기록에서 뺌({})",
                    demoted.len(),
                    demoted
                        .iter()
                        .map(|k| discovery::short(k))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            self.logged_pairs = Some(real);
        }
        let cls = classify(&seq, now);
        for k in cls.real {
            learn(state, &k, &mut ev);
            if let Some(t) = state["transient"].as_object_mut() {
                ev.urgent |= t.remove(&k).is_some();
            }
        }
        for (k, ts, gap) in cls.transient {
            if state["known"][&k].is_null() {
                if state["transient"][&k].is_null() {
                    log(&format!(
                        "{}: 앱이 계정을 바꾸며 {}초만 거친 짝 — 로그인 기록으로 치지 않음",
                        discovery::short(&k),
                        (gap + 500) / 1000
                    ));
                }
                let stamp = Utc
                    .timestamp_millis_opt(ts)
                    .single()
                    .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
                    .unwrap_or_else(discovery::stamp);
                state["transient"][&k] = json!(stamp);
                ev.urgent = true;
            }
        }
        if state["pendingInit"] != cls.pending {
            state["pendingInit"] = cls.pending;
            ev.urgent = true;
        }
        if let Some(k) = ev.inits.last() {
            state["active"] = json!(k);
        }
        if ev.logout {
            state["active"] = Value::Null;
            log("로그아웃 줄을 봄 — 기다리지 않고 바로 전부 맞춤");
        } else if let Some(k) = ev.inits.last() {
            log(&format!(
                "로그인 줄을 봄({}) — 기다리지 않고 바로 전부 맞춤",
                discovery::short(k)
            ));
        }
        for k in configs {
            learn(state, &k, &mut ev);
        }
        ev.urgent |= ev.logged;
        ev
    }
}

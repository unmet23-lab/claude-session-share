use crate::mirror::{dir_key, is_link, pair, real_dir, temp_path, Stamp, REGISTRY};
use crate::platform::log;
use serde_json::{json, Map, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

struct Registry {
    stamp: Option<Stamp>,
    data: Option<Value>,
    blocked: bool,
    ids: Vec<Value>,
}

fn read(dir: &Path) -> Registry {
    let path = dir.join(REGISTRY);
    let mut result = Registry {
        stamp: None,
        data: None,
        blocked: false,
        ids: vec![],
    };
    match fs::symlink_metadata(&path) {
        Err(e) => {
            result.blocked = e.kind() != io::ErrorKind::NotFound;
            return result;
        }
        Ok(m) if is_link(&m) || !m.is_file() => {
            result.blocked = true;
            return result;
        }
        _ => {}
    }
    result.stamp = Stamp::read(&path).ok();
    let data: Option<Value> = fs::read(&path)
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok());
    if let Some(tasks) = data.as_ref().and_then(|j| j["scheduledTasks"].as_array()) {
        result.ids = tasks
            .iter()
            .filter_map(|v| v.get("id"))
            .filter(|v| id_key(v).is_some())
            .cloned()
            .collect();
        result.data = data;
    }
    result.blocked = result.data.is_none() || result.stamp.is_none();
    result
}

fn id_key(id: &Value) -> Option<String> {
    match id {
        Value::String(s) if !s.is_empty() => Some(s.to_owned()),
        Value::Number(n) if n.as_f64() != Some(0.) => Some(n.to_string()),
        Value::Bool(true) => Some("true".into()),
        _ => None,
    }
}

fn cached(stamp: Option<Stamp>, prev: &Value) -> bool {
    stamp.is_some_and(|s| prev["m"].as_i64() == Some(s.m) && prev["s"].as_u64() == Some(s.s))
}

fn save(dir: &Path, bytes: &[u8], expected: Option<Stamp>) -> io::Result<Stamp> {
    if !real_dir(dir) {
        return Err(io::Error::other("받는 짝 폴더가 없어짐"));
    }
    let path = dir.join(REGISTRY);
    let tmp = temp_path(dir);
    let result = (|| {
        fs::write(&tmp, bytes)?;
        let current = match fs::symlink_metadata(&path) {
            Ok(meta) if is_link(&meta) || !meta.is_file() => {
                return Err(io::Error::other("예약 목록이 일반 파일이 아님"))
            }
            Ok(_) => Some(Stamp::read(&path)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        if current != expected {
            return Err(io::Error::other("쓰는 중에 예약 목록이 바뀜"));
        }
        fs::rename(&tmp, &path)?;
        Stamp::read(&path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

fn array(v: &mut Value) -> &mut Vec<Value> {
    if !v.is_array() {
        *v = json!([]);
    }
    v.as_array_mut().unwrap()
}

#[derive(Default)]
pub struct Outcome {
    pub changed: bool,
    pub written: Vec<PathBuf>,
    pub restored: usize,
}

pub fn sync(
    tree: &str,
    dirs: &[PathBuf],
    state: &mut Value,
    inits: &[String],
) -> io::Result<Outcome> {
    let mut out = Outcome::default();
    if dirs.is_empty() {
        return Ok(out);
    }
    let active = state["active"].as_str().map(str::to_owned);
    let fresh = !state["tasks"][tree].is_object();
    if fresh {
        state["tasks"][tree] = json!({"union":{},"order":[],"known":{},"dirs":{}});
    }
    let r = &mut state["tasks"][tree];
    let keys: Vec<_> = dirs.iter().map(|d| dir_key(d)).collect();
    // A failed output is still a known input. Retry delivering the merged
    // registry without importing the recipient's stale tasks as new changes.
    let retry = keys
        .iter()
        .any(|key| r["dirs"][key]["retry"].as_bool() == Some(true));
    if !fresh
        && !retry
        && inits.is_empty()
        && dirs
            .iter()
            .zip(&keys)
            .all(|(d, k)| cached(Stamp::read(&d.join(REGISTRY)).ok(), &r["dirs"][k]))
    {
        return Ok(out);
    }
    let now: Vec<_> = dirs.iter().map(|d| read(d)).collect();
    let pairs: Vec<_> = dirs.iter().map(|d| pair(d)).collect();
    let ids_at = |k: &str| {
        pairs
            .iter()
            .position(|p| p == k)
            .map(|i| &now[i])
            .filter(|x| x.data.is_some())
            .map(|v| v.ids.clone())
    };
    if fresh {
        if let Some((k, ids)) = active.as_ref().and_then(|k| ids_at(k).map(|ids| (k, ids))) {
            r["known"][k] = Value::Array(ids);
        }
    }
    for k in inits {
        r["known"][k] = Value::Array(ids_at(k).unwrap_or_default());
    }
    let mut valid: Vec<_> = (0..now.len())
        .filter(|&i| !now[i].blocked && now[i].data.is_some())
        .collect();
    valid.sort_by_key(|&i| now[i].stamp.unwrap().m);
    let changed: Vec<_> = valid
        .iter()
        .copied()
        .filter(|&i| !cached(now[i].stamp, &r["dirs"][&keys[i]]))
        .collect();
    if !retry
        && changed.is_empty()
        && inits.is_empty()
        && now.iter().all(|c| c.stamp.is_some() || c.blocked)
    {
        return Ok(out);
    }
    out.changed = fresh || !changed.is_empty() || !inits.is_empty();
    for i in changed {
        let c = &now[i];
        let key = &pairs[i];
        let st = c.stamp.unwrap();
        let known_before = r["dirs"][&keys[i]]["ids"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for task in c.data.as_ref().unwrap()["scheduledTasks"]
            .as_array()
            .unwrap()
        {
            let id = &task["id"];
            let Some(k) = id_key(id) else {
                continue;
            };
            if r["union"].get(&k).is_none() {
                r["union"][&k] = json!({"r":task,"m":st.m});
                let order = array(&mut r["order"]);
                if !order.contains(id) {
                    order.push(id.clone());
                }
                if active.as_ref() == Some(key) {
                    let known = array(&mut r["known"][key]);
                    if !known.contains(id) {
                        known.push(id.clone());
                    }
                }
                log(&format!("{tree} 예약 작업 +{k} ({key})"));
            } else if r["union"][&k]["m"].as_i64().is_none_or(|m| st.m >= m)
                && &r["union"][&k]["r"] != task
            {
                r["union"][&k] = json!({"r":task,"m":st.m});
            }
        }
        let gone: Vec<_> = known_before
            .iter()
            .filter(|id| {
                id_key(id).is_some_and(|k| r["union"].get(&k).is_some()) && !c.ids.contains(id)
            })
            .collect();
        let known = r["known"][key].as_array();
        let real: Vec<_> = gone
            .iter()
            .copied()
            .filter(|id| known.is_none_or(|v| v.contains(id)))
            .collect();
        if let [id] = real.as_slice() {
            let k = id_key(id).unwrap();
            r["union"].as_object_mut().unwrap().remove(&k);
            array(&mut r["order"]).retain(|x| x != *id);
            if let Some(known) = r["known"].as_object_mut() {
                for ids in known.values_mut() {
                    array(ids).retain(|x| x != *id);
                }
            }
            log(&format!("{tree} 예약 작업 -{k} ({key}에서 지움)"));
        }
        let kept: Vec<_> = gone
            .iter()
            .filter_map(|id| id_key(id))
            .filter(|k| r["union"].get(k).is_some())
            .collect();
        if !kept.is_empty() {
            let reason = if real.len() > 1 {
                format!("한 번에 {}개가 빠짐", real.len())
            } else {
                "앱이 모르는 작업".into()
            };
            let msg = format!(
                "{tree} 예약 작업 {}개가 {}에서 빠졌지만 지우지 않고 되살림({reason}): {}",
                kept.len(),
                crate::discovery::short(key),
                kept.join(", ")
            );
            static LAST_RESTORE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
            if let Ok(mut last) = LAST_RESTORE.lock() {
                if *last != msg {
                    log(&msg);
                    *last = msg;
                }
            }
            if active.as_ref() == Some(key) {
                out.restored = kept.len();
            }
        }
        r["dirs"][&keys[i]] = json!({"m":st.m,"s":st.s,"ids":c.ids});
    }
    let mut want = valid
        .last()
        .and_then(|&i| now[i].data.clone())
        .unwrap_or_else(|| json!({"scheduledTasks":[],"recordedSkips":{}}));
    let mut skips = Map::new();
    for i in valid {
        match &now[i].data.as_ref().unwrap()["recordedSkips"] {
            Value::Object(obj) => skips.extend(obj.clone()),
            Value::Array(list) => skips.extend(
                list.iter()
                    .enumerate()
                    .map(|(idx, v)| (idx.to_string(), v.clone())),
            ),
            _ => {}
        }
    }
    let tasks: Vec<_> = r["order"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(id_key)
        .filter_map(|k| r["union"].get(k)?.get("r").cloned())
        .collect();
    let ids: Vec<_> = tasks.iter().map(|r| r["id"].clone()).collect();
    want["scheduledTasks"] = Value::Array(tasks);
    if want.get("recordedSkips").is_some() || !skips.is_empty() {
        want["recordedSkips"] = Value::Object(skips);
    }
    let text = serde_json::to_vec_pretty(&want)?;
    for (i, d) in dirs.iter().enumerate() {
        let c = &now[i];
        if c.blocked {
            continue;
        }
        if c.data.as_ref() == Some(&want) {
            if let Some(row) = r["dirs"].get_mut(&keys[i]).and_then(Value::as_object_mut) {
                out.changed |= row.remove("retry").is_some();
            }
            continue;
        }
        match save(d, &text, c.stamp) {
            Ok(st) => {
                r["dirs"][&keys[i]] = json!({"m":st.m,"s":st.s,"ids":ids});
                out.written.push(d.clone());
                out.changed = true;
            }
            Err(e) => {
                r["dirs"][&keys[i]]["retry"] = Value::Bool(true);
                out.changed = true;
                log(&format!("{tree} 예약 목록 쓰기 실패: {e}"));
            }
        }
    }
    if !out.written.is_empty() {
        log(&format!(
            "{tree} 예약 목록을 {}개로 {}곳 맞춤",
            ids.len(),
            out.written.len()
        ));
    }
    Ok(out)
}

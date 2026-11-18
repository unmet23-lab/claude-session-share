use crate::{
    discovery::count_records,
    mirror::{backup_files, copy_stamped, is_link, pair, real_dir, temp_name},
    platform::log,
    Family, TREES,
};
use chrono::Local;
use serde_json::Value;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

const KEEP: usize = 24;

fn hourly_name(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 11 && b[8] == b'-' && b[..8].iter().chain(&b[9..]).all(u8::is_ascii_digit)
}

fn hourly_dirs(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for item in fs::read_dir(dir)? {
        let entry = item?;
        if entry.file_name().to_str().is_some_and(hourly_name) && real_dir(&entry.path()) {
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}

fn backup_dir(data: &Path) -> io::Result<PathBuf> {
    let root = data.join("claude-session-backups");
    fs::create_dir_all(&root)?;
    if !real_dir(&root) {
        return Err(io::Error::other("백업 폴더가 연결 경로로 바뀜"));
    }
    Ok(root)
}

fn discard_staging(parent: &Path, tmp: &Path) -> io::Result<()> {
    if tmp.parent() != Some(parent)
        || !tmp
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with(".making-"))
    {
        return Err(io::Error::other("임시 백업 경로가 다름"));
    }
    if real_dir(tmp) {
        fs::remove_dir_all(tmp)?;
    }
    Ok(())
}

fn clear_abandoned(root: &Path) -> io::Result<()> {
    // CLI의 상태 폴더 잠금 아래에서만 호출한다. 이전 판이나 비정상 종료 뒤 남은 백업에만 적용한다.
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let n = entry.file_name();
        let Some((name, pid)) = n
            .to_str()
            .and_then(|s| s.strip_prefix(".making-"))
            .and_then(|s| s.rsplit_once('-'))
        else {
            continue;
        };
        let before = name.strip_suffix("-before-mirror").is_some_and(|s| {
            s.len() == 15
                && s.get(..11).is_some_and(hourly_name)
                && s.as_bytes()[11..].iter().all(u8::is_ascii_digit)
        });
        if pid.parse::<u32>().is_ok() && (hourly_name(name) || before) {
            discard_staging(root, &entry.path())?;
        }
    }
    Ok(())
}
pub fn snapshot(data: &Path, family: &Family, state: &Value) -> io::Result<()> {
    let Some(dirs) = family.get("claude-code-sessions") else {
        return Ok(());
    };
    let mut source = None;
    let mut largest = 0;
    for d in dirs.iter().filter(|p| real_dir(p)) {
        let count = count_records(d);
        if source.is_none()
            || count > largest
            || (count == largest && state["active"].as_str() == Some(&pair(d)))
        {
            largest = count;
            source = Some(d);
        }
    }
    let Some(src) = source else { return Ok(()) };
    let root = backup_dir(data)?;
    let name = Local::now().format("%Y%m%d-%H").to_string();
    let dest = root.join(&name);
    if dest.try_exists()? {
        return Ok(());
    }
    clear_abandoned(&root)?;
    let previous = hourly_dirs(&root)?.into_iter().rfind(|p| p < &dest);
    let current = backup_files(src)?;
    let base = match &previous {
        Some(p) => backup_files(p)?,
        None => Default::default(),
    };
    if previous.is_some() && current == base {
        return Ok(());
    }
    let tmp = root.join(format!(".making-{name}-{}", std::process::id()));
    fs::create_dir(&tmp)?;
    let (mut copied, mut linked, mut bytes) = (0usize, 0usize, 0u64);
    let result = (|| {
        for (rel, st) in &current {
            let to = tmp.join(rel);
            fs::create_dir_all(to.parent().unwrap())?;
            if let Some(prev) = previous.as_ref().filter(|_| base.get(rel) == Some(st)) {
                if fs::hard_link(prev.join(rel), &to).is_ok() {
                    linked += 1;
                    continue;
                }
            }
            copy_stamped(&src.join(rel), &to, *st)?;
            copied += 1;
            bytes += st.s;
        }
        fs::rename(&tmp, &dest)
    })();
    if let Err(e) = result {
        discard_staging(&root, &tmp)?;
        if real_dir(&dest) {
            return Ok(());
        }
        return Err(e);
    }
    log(&format!(
        "매시간 백업 {name}: 바뀐 파일 {copied}개({:.1}MB)만 새로 쓰고 {linked}개는 앞 백업에 이음",
        bytes as f64 / 1048576.0
    ));
    let all = hourly_dirs(&root)?;
    for p in all.iter().take(all.len().saturating_sub(KEEP)) {
        if p.parent() == Some(&root) && real_dir(p) {
            fs::remove_dir_all(p)?;
        }
    }
    Ok(())
}

fn copy_tree(src: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for item in fs::read_dir(src)? {
        let e = item?;
        if e.file_name().to_str().is_some_and(temp_name) {
            continue;
        }
        let m = fs::symlink_metadata(e.path())?;
        if is_link(&m) {
            continue;
        }
        let target = to.join(e.file_name());
        if m.is_dir() {
            copy_tree(&e.path(), &target)?;
        } else if m.is_file() {
            copy_stamped(&e.path(), &target, crate::mirror::Stamp::read(&e.path())?)?;
        }
    }
    Ok(())
}

pub fn snapshot_all(data: &Path, roots: &[PathBuf]) -> io::Result<Option<PathBuf>> {
    if roots.is_empty() {
        return Ok(None);
    }
    let root = backup_dir(data)?;
    let name = Local::now()
        .format("%Y%m%d-%H%M%S-before-mirror")
        .to_string();
    let dest = root.join(&name);
    if dest.try_exists()? {
        return Ok(None);
    }
    let tmp = root.join(format!(".making-{name}-{}", std::process::id()));
    discard_staging(&root, &tmp)?;
    fs::create_dir(&tmp)?;
    let result = (|| {
        let mut origins = String::new();
        for (i, d) in roots.iter().enumerate() {
            let slot = format!("root{}", i + 1);
            let parent = if roots.len() > 1 {
                tmp.join(&slot)
            } else {
                tmp.clone()
            };
            for t in TREES {
                let src = d.join(t);
                if real_dir(&src) {
                    copy_tree(&src, &parent.join(t))?;
                }
            }
            origins.push_str(&format!("{slot}\t{}\n", d.display()));
        }
        if roots.len() > 1 {
            fs::write(tmp.join("roots.txt"), origins)?;
        }
        fs::rename(&tmp, &dest)
    })();
    if let Err(e) = result {
        discard_staging(&root, &tmp)?;
        return Err(e);
    }
    Ok(Some(dest))
}

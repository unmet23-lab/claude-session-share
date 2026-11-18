use crate::{
    discovery::count_records,
    mirror::{backup_files, is_link, pair, real_dir, temp_name, Stamp},
    platform::log,
    Family, TREES,
};
use chrono::Local;
use serde_json::Value;
use std::{
    fs,
    io::{self, Read},
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
// A scan decides which snapshot is due. Each individual file gets its version and timestamp
// from one open handle, so an atomic replacement of the source name cannot mix versions.
enum Capture {
    Linked,
    Copied(u64),
}

fn open_source(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

fn capture_open(
    source: &mut fs::File,
    dest: &Path,
    previous: Option<(&Path, Stamp)>,
) -> io::Result<Capture> {
    let before = source.metadata()?;
    if !before.is_file() || is_link(&before) {
        return Err(io::Error::other("백업 원본이 일반 파일이 아님"));
    }
    let stamp = Stamp::from_meta(&before)?;
    if let Some((path, _)) = previous.filter(|(_, old)| *old == stamp) {
        if fs::hard_link(path, dest).is_ok() {
            return Ok(Capture::Linked);
        }
    }
    let mut output = fs::File::create_new(dest)?;
    let result = (|| {
        let copied = io::copy(&mut source.take(stamp.s.saturating_add(1)), &mut output)?;
        let after = source.metadata()?;
        if copied != before.len()
            || after.len() != before.len()
            || before.modified()? != after.modified()?
        {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "복사 중에 파일 내용이 바뀜",
            ));
        }
        let modified = before.modified()?;
        output.set_times(
            fs::FileTimes::new()
                .set_accessed(modified)
                .set_modified(modified),
        )?;
        if before.permissions().readonly() {
            output.set_permissions(before.permissions())?;
        }
        Ok(Capture::Copied(copied))
    })();
    drop(output);
    if result.is_err() {
        fs::remove_file(dest)?;
    }
    result
}

fn capture_file(
    source: &Path,
    dest: &Path,
    previous: Option<(&Path, Stamp)>,
) -> io::Result<Capture> {
    for attempt in 0..4 {
        match open_source(source).and_then(|mut f| capture_open(&mut f, dest, previous)) {
            Err(e)
                if attempt < 3
                    && (matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::Interrupted
                            | io::ErrorKind::NotFound
                    ) || matches!(e.raw_os_error(), Some(32 | 33))) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10 << attempt));
            }
            result => return result,
        }
    }
    unreachable!()
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
        for rel in current.keys() {
            let to = tmp.join(rel);
            fs::create_dir_all(to.parent().unwrap())?;
            let prior = previous
                .as_ref()
                .and_then(|dir| base.get(rel).map(|st| (dir.join(rel), *st)));
            let candidate = prior.as_ref().map(|(p, st)| (p.as_path(), *st));
            match capture_file(&src.join(rel), &to, candidate)? {
                Capture::Linked => linked += 1,
                Capture::Copied(n) => {
                    copied += 1;
                    bytes += n;
                }
            }
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
            capture_file(&e.path(), &target, None)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn capture_uses_open_file_version_even_when_scan_or_path_is_stale() -> io::Result<()> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("session-snapshot-{}-{nonce}", std::process::id()));
        fs::create_dir(&root)?;
        let run = || -> io::Result<()> {
            let src = root.join("local_live.json");
            let base = root.join("previous.json");
            fs::write(&src, b"old")?;
            let scanned = backup_files(&root)?["local_live.json"];
            fs::write(&base, b"old")?;
            // The scan suggested reusing the old hard link, but the app published a new version first.
            let incoming = root.join("incoming");
            fs::write(&incoming, b"fresh version")?;
            fs::rename(&incoming, &src)?;
            let dst = root.join("new-snapshot");
            assert!(matches!(
                capture_file(&src, &dst, Some((&base, scanned)))?,
                Capture::Copied(13)
            ));
            assert_eq!(fs::read(&dst)?, b"fresh version");
            assert_eq!(Stamp::read(&dst)?, Stamp::read(&src)?);
            assert_eq!(fs::read(&base)?, b"old");

            // A second atomic publish leaves the open file readable through its previous name's handle.
            let mut opened = open_source(&src)?;
            let expected = opened.metadata()?.modified()?;
            fs::write(&incoming, b"next version")?;
            fs::rename(&incoming, &src)?;
            let full = root.join("full-snapshot");
            assert!(matches!(
                capture_open(&mut opened, &full, None)?,
                Capture::Copied(13)
            ));
            assert_eq!(fs::read(full.clone())?, b"fresh version");
            assert_eq!(fs::metadata(full)?.modified()?, expected);
            assert_eq!(fs::read(src)?, b"next version");
            Ok(())
        };
        let result = run();
        fs::remove_dir_all(&root)?;
        result
    }
}

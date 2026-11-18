use crate::discovery::lower;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, BufWriter, Write},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use windows_sys::Win32::{
    Foundation::FILETIME,
    Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    },
};

pub type FileId = (u32, u64);
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct DirInfo {
    pub id: FileId,
    pub birth: Option<SystemTime>,
    pub modified: Option<SystemTime>,
}

fn system_time(t: FILETIME) -> Option<SystemTime> {
    let ticks = ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
    let unix = ticks.checked_sub(116444736000000000)?;
    UNIX_EPOCH.checked_add(Duration::new(
        unix / 10_000_000,
        ((unix % 10_000_000) * 100) as u32,
    ))
}
pub fn observe(path: &Path) -> io::Result<DirInfo> {
    let f = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(f.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
        != FILE_ATTRIBUTE_DIRECTORY
        || index == 0
    {
        return Err(io::Error::other(
            "실제 폴더의 파일 ID를 확인하지 못했습니다",
        ));
    }
    Ok(DirInfo {
        id: (info.dwVolumeSerialNumber, index),
        birth: system_time(info.ftCreationTime),
        modified: system_time(info.ftLastWriteTime),
    })
}

// v2 state stays readable by the Node implementation. Commit changes to its deletion baselines
// before replacing a previously recorded ID here. A crash between the two writes repeats the reset.
pub struct Ledger {
    path: PathBuf,
    entries: Option<BTreeMap<String, FileId>>,
}
impl Ledger {
    pub fn new(data: &Path) -> Self {
        Self {
            path: data.join("claude-session-share-directories.json"),
            entries: None,
        }
    }
    fn load(&mut self) -> io::Result<&mut BTreeMap<String, FileId>> {
        if self.entries.is_none() {
            let entries = match File::open(&self.path) {
                Ok(f) => serde_json::from_reader(f)?,
                Err(e) if e.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
                Err(e) => return Err(e),
            };
            self.entries = Some(entries);
        }
        Ok(self.entries.as_mut().unwrap())
    }
    pub fn get(&mut self, dir: &Path) -> io::Result<Option<FileId>> {
        Ok(self.load()?.get(&lower(dir)).copied())
    }
    pub fn record(&mut self, dir: &Path, id: FileId) -> io::Result<()> {
        let key = lower(dir);
        if self.load()?.get(&key) == Some(&id) {
            return Ok(());
        }
        let map = self.entries.as_mut().unwrap();
        let old = map.insert(key.clone(), id);
        let tmp = self
            .path
            .with_extension(format!("{}.tmp", std::process::id()));
        let result = (|| -> io::Result<()> {
            let mut file = BufWriter::new(File::create(&tmp)?);
            serde_json::to_writer(&mut file, &map)?;
            file.flush()?;
            file.get_ref().sync_all()?;
            drop(file);
            fs::rename(&tmp, &self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(tmp);
            if let Some(previous) = old {
                map.insert(key, previous);
            } else {
                map.remove(&key);
            }
        }
        result
    }
}

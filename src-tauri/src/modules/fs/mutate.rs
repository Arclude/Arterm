use crate::modules::workspace::{authorize_fs_path, WorkspaceEnv, WorkspaceRegistry};

/// Creates a new empty file. Fails if the file already exists.
#[tauri::command]
pub fn fs_create_file(
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    create_file_inner(&path, workspace, &registry)
}

pub(crate) fn create_file_inner(
    path: &str,
    workspace: Option<WorkspaceEnv>,
    registry: &WorkspaceRegistry,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = authorize_fs_path(registry, path, &workspace)?;
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::write(&p, "").map_err(|e| {
        log::debug!("fs_create_file({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Creates a new directory. Fails if the directory already exists.
/// Parents are created as needed — matches the common "new folder" UX
/// where typing "a/b/c" creates the full chain.
#[tauri::command]
pub fn fs_create_dir(
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    create_dir_inner(&path, workspace, &registry)
}

pub(crate) fn create_dir_inner(
    path: &str,
    workspace: Option<WorkspaceEnv>,
    registry: &WorkspaceRegistry,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = authorize_fs_path(registry, path, &workspace)?;
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::create_dir_all(&p).map_err(|e| {
        log::debug!("fs_create_dir({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Renames (or moves) a path. Refuses to overwrite an existing target.
#[tauri::command]
pub fn fs_rename(
    from: String,
    to: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    rename_inner(&from, &to, workspace, &registry)
}

pub(crate) fn rename_inner(
    from: &str,
    to: &str,
    workspace: Option<WorkspaceEnv>,
    registry: &WorkspaceRegistry,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let from_p = authorize_fs_path(registry, from, &workspace)?;
    let to_p = authorize_fs_path(registry, to, &workspace)?;
    if !from_p.exists() {
        return Err(format!("not found: {}", from_p.display()));
    }
    if to_p.exists() {
        return Err(format!("already exists: {}", to_p.display()));
    }
    std::fs::rename(&from_p, &to_p).map_err(|e| {
        log::debug!(
            "fs_rename({} -> {}) failed: {e}",
            from_p.display(),
            to_p.display()
        );
        e.to_string()
    })
}

/// Deletes a file or directory (recursively for dirs). Callers are
/// responsible for confirming destructive operations with the user.
#[tauri::command]
pub fn fs_delete(
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    delete_inner(&path, workspace, &registry)
}

pub(crate) fn delete_inner(
    path: &str,
    workspace: Option<WorkspaceEnv>,
    registry: &WorkspaceRegistry,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let p = authorize_fs_path(registry, path, &workspace)?;
    let meta = std::fs::symlink_metadata(&p).map_err(|e| {
        log::debug!("fs_delete stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let result = if meta.is_dir() {
        std::fs::remove_dir_all(&p)
    } else {
        std::fs::remove_file(&p)
    };

    result.map_err(|e| {
        log::warn!("fs_delete({}) failed: {e}", p.display());
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: std::path::PathBuf) -> String {
        p.to_string_lossy().into_owned()
    }

    /// A registry that authorizes `dir` so the fs gate lets test mutations through.
    fn test_reg(dir: &std::path::Path) -> WorkspaceRegistry {
        let reg = WorkspaceRegistry::default();
        reg.authorize(dir).expect("authorize test dir");
        reg
    }

    #[test]
    fn create_file_makes_empty_and_refuses_to_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let reg = test_reg(dir.path());
        let f = dir.path().join("new.txt");
        create_file_inner(&s(f.clone()), None, &reg).expect("create");
        assert!(f.exists());
        assert_eq!(std::fs::read(&f).unwrap(), b"");

        // A second create must error, not truncate existing content.
        std::fs::write(&f, b"data").unwrap();
        let err = create_file_inner(&s(f.clone()), None, &reg).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(std::fs::read(&f).unwrap(), b"data");
    }

    #[test]
    fn create_dir_builds_nested_chain_and_refuses_existing() {
        let dir = tempfile::tempdir().unwrap();
        let reg = test_reg(dir.path());
        let nested = dir.path().join("a/b/c");
        create_dir_inner(&s(nested.clone()), None, &reg).expect("create dir");
        assert!(nested.is_dir());
        let err = create_dir_inner(&s(nested), None, &reg).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[test]
    fn rename_moves_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let reg = test_reg(dir.path());
        let from = dir.path().join("a.txt");
        let to = dir.path().join("b.txt");
        std::fs::write(&from, b"payload").unwrap();

        rename_inner(&s(from.clone()), &s(to.clone()), None, &reg).expect("rename");
        assert!(!from.exists());
        assert_eq!(std::fs::read(&to).unwrap(), b"payload");

        // Missing source is reported, not silently ignored.
        let err = rename_inner(&s(from), &s(dir.path().join("c.txt")), None, &reg).unwrap_err();
        assert!(err.contains("not found"), "got: {err}");

        // Refusing to overwrite an existing target is the data-loss guard.
        let occupied = dir.path().join("keep.txt");
        std::fs::write(&occupied, b"keep").unwrap();
        let err = rename_inner(&s(to.clone()), &s(occupied.clone()), None, &reg).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        assert_eq!(std::fs::read(&occupied).unwrap(), b"keep");
        assert!(to.exists());
    }

    #[test]
    fn delete_removes_file_then_dir_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let reg = test_reg(dir.path());
        let f = dir.path().join("x.txt");
        std::fs::write(&f, b"x").unwrap();
        delete_inner(&s(f.clone()), None, &reg).expect("delete file");
        assert!(!f.exists());

        let sub = dir.path().join("sub");
        std::fs::create_dir_all(sub.join("inner")).unwrap();
        std::fs::write(sub.join("inner/y.txt"), b"y").unwrap();
        delete_inner(&s(sub.clone()), None, &reg).expect("delete dir");
        assert!(!sub.exists());

        let err = delete_inner(&s(dir.path().join("missing")), None, &reg).unwrap_err();
        assert!(!err.is_empty());
    }

    // Deleting a symlink that points at a directory must remove only the link,
    // never recurse through it and wipe the target's contents.
    #[cfg(unix)]
    #[test]
    fn delete_does_not_follow_symlink_into_target() {
        let dir = tempfile::tempdir().unwrap();
        let reg = test_reg(dir.path());
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("keep.txt"), b"keep").unwrap();

        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        delete_inner(&s(link.clone()), None, &reg).expect("delete symlink");
        assert!(!link.exists(), "symlink itself should be gone");
        assert!(real.is_dir(), "target dir must survive");
        assert_eq!(std::fs::read(real.join("keep.txt")).unwrap(), b"keep");
    }
}

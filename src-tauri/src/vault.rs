use serde::Serialize;
use std::{path::Path, process::Command};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub path: String,
    pub locked: bool,
    /// Epoch seconds at which the temporary unlock ends and the folder re-locks.
    pub unlock_at: Option<u64>,
}

/// `whoami` output ("HOST\user" or "domain\user") is the most reliable ACE
/// principal; fall back to bare USERNAME.
pub fn current_user() -> String {
    let from_cmd = crate::util::hidden(&mut Command::new("whoami"))
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    from_cmd
        .or_else(|| std::env::var("USERNAME").ok())
        .unwrap_or_default()
}

fn icacls(args: &[String]) -> Result<String, String> {
    let out = crate::util::hidden(&mut Command::new("icacls"))
        .args(args)
        .output()
        .map_err(|e| format!("failed to run icacls: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(text)
    } else {
        Err(text.trim().to_string())
    }
}

fn deny_children_spec(user: &str) -> String {
    format!("{user}:(OI)(CI)(D,DC)")
}

fn deny_self_spec(user: &str) -> String {
    format!("{user}:(D)")
}

/// Two explicit deny ACEs on the vault root:
///  - `(OI)(CI)(D,DC)` — children cannot be deleted (inherited by all files/dirs)
///  - `(D)`            — the folder itself cannot be deleted once empty
/// No parent ACL is touched.
pub fn lock(path: &Path, user: &str) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    let p = path.to_string_lossy().into_owned();
    icacls(&[p.clone(), "/deny".into(), deny_children_spec(user)])?;
    icacls(&[p, "/deny".into(), deny_self_spec(user)])?;
    Ok(())
}

/// `/remove:d` strips every deny ACE for the user on the folder; the inherited
/// copies on children disappear with their source. Allow ACEs stay untouched.
pub fn unlock(path: &Path, user: &str) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    icacls(&[
        path.to_string_lossy().into_owned(),
        "/remove:d".into(),
        user.into(),
    ])?;
    Ok(())
}

/// The ACL is the source of truth — a lock persists across app restarts and
/// survives even if this app is killed.
pub fn is_locked(path: &Path, user: &str) -> bool {
    let uname = user.rsplit('\\').next().unwrap_or(user).to_lowercase();
    crate::util::hidden(&mut Command::new("icacls"))
        .arg(path)
        .output()
        .ok()
        .map(|o| {
            let text = String::from_utf8_lossy(&o.stdout);
            text.lines().any(|line| {
                let l = line.to_lowercase();
                l.contains("deny") && l.contains(&uname)
            })
        })
        .unwrap_or(false)
}

/// Opens the folder in the OS file manager. `explorer`/`open` return odd
/// exit codes even on success, so we only spawn — never wait on it.
pub fn open_in_explorer(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    crate::util::hidden(&mut Command::new(crate::util::opener()))
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open file manager: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn ace_specs_have_delete_rights() {
        assert_eq!(deny_children_spec("HOST\\bob"), "HOST\\bob:(OI)(CI)(D,DC)");
        assert_eq!(deny_self_spec("HOST\\bob"), "HOST\\bob:(D)");
    }

    #[cfg(windows)]
    #[test]
    fn lock_blocks_delete_and_unlock_restores() {
        let user = current_user();
        assert!(!user.is_empty(), "whoami/USERNAME must resolve");
        let dir = std::env::temp_dir().join(format!("cairn-vault-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let child = dir.join("precious.txt");
        fs::write(&child, b"do not lose me").unwrap();

        lock(&dir, &user).unwrap();
        assert!(is_locked(&dir, &user));
        assert!(
            fs::remove_file(&child).is_err(),
            "delete inside locked vault must fail"
        );

        unlock(&dir, &user).unwrap();
        assert!(!is_locked(&dir, &user));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn lock_rejects_nonexistent_dir() {
        let user = current_user();
        assert!(lock(Path::new("Z:\\no-such-cairn-dir-xyz"), &user).is_err());
    }
}

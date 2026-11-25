// Path helpers that work on both Windows (`C:\foo`) and POSIX (`/foo`)
// roots — the disk tab drills on whatever separator the scanned root uses.

/** The separator a path is written with — `\` when any backslash appears,
 * or when it starts with a bare drive root like `D:`. */
export function sepOf(path: string): "\\" | "/" {
  return path.includes("\\") || /^[a-zA-Z]:/.test(path) ? "\\" : "/";
}

/** Last path segment (file/dir name), or the whole path for bare roots. */
export function baseName(path: string): string {
  return (
    path
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? path
  );
}

/**
 * Ancestor chain BELOW the drive root — every intermediate path from the
 * first child down to `path` itself, so a deep jump renders an accurate
 * breadcrumb trail. `D:\a\b` → [`D:\a`, `D:\a\b`]; `/a/b` → [`/a`, `/a/b`].
 * Windows drops the drive letter (it renders as the root crumb); POSIX
 * keeps every segment because the leading `/` already IS the root crumb.
 */
export function ancestorChain(path: string): string[] {
  const sep = sepOf(path);
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (sep === "\\") {
    return parts.slice(1).map((_, i) => parts.slice(0, i + 2).join(sep));
  }
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`);
}

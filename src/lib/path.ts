export const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

export const dirname = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

export const extname = (p: string): string => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
};

/** Forward slashes, no trailing slash, except for filesystem roots ("C:/", "/"). */
export const normPath = (p: string): string => {
  const s = p.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/*$/.test(s)) return s.slice(0, 2) + "/";
  return s.replace(/\/+$/, "") || (s.startsWith("/") ? "/" : "");
};

/** Every ancestor directory of a relative path, nearest last ("a", "a/b"). */
export function ancestors(p: string): string[] {
  const parts = p.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Shows sibling worktrees as "../name", like the mockup. */
export function displayWorktreePath(path: string, mainPath: string | null): string {
  if (!mainPath || path === mainPath) return path;
  const parent = dirname(mainPath);
  if (dirname(path) === parent) return "../" + basename(path);
  return path;
}

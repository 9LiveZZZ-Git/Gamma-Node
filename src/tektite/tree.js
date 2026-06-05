/* =========================================================================
 * Tektite MD -- folder tree builder + flat-to-nested converter
 *
 * Phase C sprint tektite-5a. Takes a flat list of note entries (any
 * source -- vault IDB, local FS, GitHub) where each entry has an `id`
 * (or `path`) that may contain `/` separators, and builds a nested
 * folder tree the sidebar can render hierarchically.
 *
 * Tree node shape:
 *   { type:"folder", name, path, children:[], count }
 *   { type:"file",   name, note }   // note = original listing entry
 *
 * The renderer walks the tree depth-first, indenting each level by
 * 14 px. Folders track their open/closed state in
 * _tektiteTabState.openFolders (Set<string>) so reload + filter
 * cycles preserve the user's expand/collapse decisions.
 *
 * Public surface:
 *   tektiteBuildTree(listing)
 *     -> root folder node
 *   tektiteFlattenTree(root)
 *     -> [{ type, depth, ...node }]    pre-order for renderer iteration
 *   tektiteCountTreeFiles(node)
 *     -> int                            total file leaves under a folder
 * ======================================================================== */

function tektiteBuildTree(listing) {
  const root = { type: "folder", name: "", path: "", children: [], count: 0 };
  if (!Array.isArray(listing)) return root;
  for (const n of listing) {
    const path = String(n.id || n.path || "").replace(/^\/+/, "");
    if (!path) continue;
    const parts = path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i];
      let child = cur.children.find(c => c.type === "folder" && c.name === folderName);
      if (!child) {
        child = {
          type: "folder",
          name: folderName,
          path: parts.slice(0, i + 1).join("/"),
          children: [],
          count: 0
        };
        cur.children.push(child);
      }
      cur = child;
    }
    cur.children.push({
      type: "file",
      name: n.title || parts[parts.length - 1].replace(/\.md$/i, ""),
      note: n
    });
  }
  // Recursive sort -- folders first, then files; both alphabetical.
  // Also computes each folder's transitive file count for the badge.
  function sortAndCount(node) {
    if (node.type !== "folder") return 0;
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    let count = 0;
    for (const c of node.children) count += sortAndCount(c) || 1;
    node.count = count;
    return count;
  }
  sortAndCount(root);
  return root;
}

/* Pre-order flatten. Used by the sidebar renderer so it can iterate
 * with a single map() instead of a recursive HTML-building walk.
 * Each emitted entry carries { type, depth, name, path?, note? } so
 * the renderer can both compute indent + bind click handlers. */
function tektiteFlattenTree(root, openFolders, depth, out) {
  out = out || [];
  depth = depth || 0;
  if (!root) return out;
  // Skip the synthetic root node; only emit its children.
  if (depth === 0 && root.type === "folder" && root.name === "") {
    for (const child of root.children) tektiteFlattenTree(child, openFolders, 0, out);
    return out;
  }
  if (root.type === "folder") {
    const isOpen = !openFolders || openFolders.has(root.path);
    out.push({
      type:  "folder",
      name:  root.name,
      path:  root.path,
      count: root.count,
      depth, isOpen
    });
    if (isOpen) {
      for (const child of root.children) tektiteFlattenTree(child, openFolders, depth + 1, out);
    }
  } else {
    out.push({
      type: "file",
      name: root.name,
      note: root.note,
      depth
    });
  }
  return out;
}

function tektiteCountTreeFiles(node) {
  if (!node) return 0;
  if (node.type === "file") return 1;
  let n = 0;
  if (Array.isArray(node.children)) {
    for (const c of node.children) n += tektiteCountTreeFiles(c);
  }
  return n;
}

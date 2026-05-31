// Shapes the file browser exchanges with the UI. One `FileEntry` per immediate
// child of a directory; `size` is the recursive total (du) for dirs and the
// file size for files — so the UI can rank "what's using space" without more
// round-trips.

export type FileKind = 'dir' | 'file' | 'other';

export type FileEntry = {
  name: string;
  path: string;     // absolute
  type: FileKind;
  size: number;     // bytes — recursive total for dirs, own size for files
  mtime: number;    // unix seconds
};

// Streamed over /ws/files/list. `meta` first (the listed dir + its parent), then
// an `entry` per child (dirs arrive with size 0), then a `size` per directory as
// its recursive `du` completes, then `done`. `error` ends the stream early.
export type FilesEvent =
  | { type: 'meta'; path: string; parent: string | null }
  | { type: 'entry'; entry: FileEntry }
  | { type: 'size'; path: string; size: number }
  | { type: 'done' }
  | { type: 'error'; message: string };

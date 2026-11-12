// Which folder the app opens at startup.

export interface StartupSources {
  /** Folder given on the command line, or null. */
  launch: string | null;
  /** Folders opened before, most recent first. */
  recents: readonly string[];
  /** Folder to use when nothing else opens (the working directory). */
  fallback: () => Promise<string>;
}

/**
 * Opens, in this order: the folder the app was asked to open, the last folder
 * used, the fallback. A recent folder that no longer opens (deleted, moved,
 * drive not connected) is skipped in favour of the one used before it.
 * Resolves to the folder that was opened; rejects when not even the fallback
 * opens.
 */
export async function openStartup(src: StartupSources, open: (folder: string) => Promise<void>): Promise<string> {
  if (src.launch) {
    await open(src.launch);
    return src.launch;
  }
  for (const folder of src.recents) {
    try {
      await open(folder);
      return folder;
    } catch {
      /* gone or unreadable: try the one used before it */
    }
  }
  const folder = await src.fallback();
  await open(folder);
  return folder;
}

// Debug flags handed from the main process to renderer preloads through
// webPreferences.additionalArguments, so a preload knows at startup whether
// diagnostic collection is wanted. Stable builds pass them as off, letting
// the preload skip expensive debug-only DOM scans and IPC entirely.
export type RendererDebugFlags = {
  mediaOverlay: boolean;
  reload: boolean;
};

const FLAG_ARGS: Record<keyof RendererDebugFlags, string> = {
  mediaOverlay: "--md-debug-media-overlay",
  reload: "--md-debug-reload",
};

export const encodeRendererDebugFlags = (flags: RendererDebugFlags): string[] =>
  (Object.keys(FLAG_ARGS) as Array<keyof RendererDebugFlags>).map(
    (key) => `${FLAG_ARGS[key]}=${flags[key] ? "1" : "0"}`,
  );

export const decodeRendererDebugFlags = (
  argv: readonly string[],
): RendererDebugFlags => {
  const read = (key: keyof RendererDebugFlags): boolean =>
    argv.includes(`${FLAG_ARGS[key]}=1`);
  return { mediaOverlay: read("mediaOverlay"), reload: read("reload") };
};

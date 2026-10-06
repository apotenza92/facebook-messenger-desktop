import type { EventEmitter } from "events";

type ErrorStream = Pick<EventEmitter, "on"> | null | undefined;

type GuardedProcess = Pick<EventEmitter, "on"> & {
  stdout?: ErrorStream;
  stderr?: ErrorStream;
};

export const isBrokenPipeError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const err = error as NodeJS.ErrnoException;
  return (
    err.code === "EPIPE" || /write\s+EPIPE/i.test(String(err.message || ""))
  );
};

const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
};

// Broken stdout/stderr pipes (for example a closed launching terminal) must
// never take down the app. Every other uncaught error is reported once and
// the process keeps running, matching Electron's default main-process
// behaviour. Re-throwing from here would re-enter this handler forever.
export const installPipeErrorGuards = (
  proc: GuardedProcess,
  report: (message: string) => void,
): void => {
  const handle = (kind: string) => (error: unknown) => {
    if (isBrokenPipeError(error)) return;
    try {
      report(`[App] ${kind}: ${describeError(error)}`);
    } catch {
      // Reporting itself failed (for example stderr is gone); nothing safer
      // is left to do.
    }
  };

  proc.stdout?.on?.("error", handle("Output stream error"));
  proc.stderr?.on?.("error", handle("Output stream error"));
  proc.on("uncaughtException", handle("Uncaught exception"));
  proc.on("unhandledRejection", handle("Unhandled rejection"));
};

export type IncomingCallOverlayHintPayload =
  | { visible?: boolean; reason?: string }
  | boolean;

export type IncomingCallOverlayHintState = {
  visibleByWebContentsId: Map<number, boolean>;
  lastHintAtByWebContentsId: Map<number, number>;
};

export function parseIncomingCallOverlayHintVisible(
  payload: IncomingCallOverlayHintPayload,
): boolean {
  return typeof payload === "boolean"
    ? payload
    : payload && typeof payload.visible === "boolean"
      ? payload.visible
      : false;
}

export function shouldAcceptIncomingCallOverlayHintSender(
  senderWebContentsId: number,
  activeMessengerWebContentsId: number | null,
): boolean {
  return (
    activeMessengerWebContentsId !== null &&
    senderWebContentsId === activeMessengerWebContentsId
  );
}

export function applyIncomingCallOverlayHintSignal(
  state: IncomingCallOverlayHintState,
  webContentsId: number,
  visible: boolean,
  now: number,
): {
  previousVisible: boolean;
  nextVisible: boolean;
  changed: boolean;
  heartbeat: boolean;
} {
  const previousVisible =
    state.visibleByWebContentsId.get(webContentsId) === true;

  if (visible) {
    state.visibleByWebContentsId.set(webContentsId, true);
    state.lastHintAtByWebContentsId.set(webContentsId, now);
  } else {
    state.visibleByWebContentsId.set(webContentsId, false);
    state.lastHintAtByWebContentsId.delete(webContentsId);
  }

  return {
    previousVisible,
    nextVisible: visible,
    changed: previousVisible !== visible,
    heartbeat: visible && previousVisible,
  };
}

export function clearIncomingCallOverlayHintState(
  state: IncomingCallOverlayHintState,
  webContentsId: number,
): { previousVisible: boolean; changed: boolean } {
  const previousVisible =
    state.visibleByWebContentsId.get(webContentsId) === true;
  state.visibleByWebContentsId.set(webContentsId, false);
  state.lastHintAtByWebContentsId.delete(webContentsId);
  return {
    previousVisible,
    changed: previousVisible,
  };
}

export function collectStaleIncomingCallOverlayHintIds(
  state: IncomingCallOverlayHintState,
  now: number,
  ttlMs: number,
): number[] {
  const stale: number[] = [];

  for (const [webContentsId, visible] of state.visibleByWebContentsId.entries()) {
    if (!visible) continue;

    const lastHintAt = state.lastHintAtByWebContentsId.get(webContentsId);
    if (typeof lastHintAt !== "number" || now - lastHintAt > ttlMs) {
      stale.push(webContentsId);
    }
  }

  return stale;
}

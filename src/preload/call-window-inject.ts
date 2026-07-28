/**
 * Call window injection script - injected into page context to release microphone
 * Uses multiple strategies since we can't intercept getUserMedia early enough
 * Fixes issue #33: Microphone not released after calls end
 */

(() => {
  // Prevent double injection
  if ((window as any).__callWindowInjected) {
    return;
  }
  (window as any).__callWindowInjected = true;

  // Track streams we capture via RTCPeerConnection interception
  const activeStreams = new Set<MediaStream>();
  const activePeerConnections = new Set<RTCPeerConnection>();
  let hasSeenActiveCallUi = false;
  let callHasEnded = false;
  let postCallUserGestureUntil = 0;
  let blockedPostCallMediaRequests = 0;
  let callWindowStateTimer: number | null = null;
  let lastCallWindowStateSignature = "";

  const mediaDevices = navigator.mediaDevices;
  const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);

  function stopStreamTracks(stream: MediaStream, reason: string): number {
    let tracksStopped = 0;
    stream.getTracks().forEach((track) => {
      if (track.readyState !== "ended") {
        track.stop();
        tracksStopped++;
      }
    });
    activeStreams.delete(stream);
    if (tracksStopped > 0) {
      console.log(
        `[Call Window] Released ${tracksStopped} media tracks (${reason})`,
      );
    }
    return tracksStopped;
  }

  async function guardedGetUserMedia(
    constraints?: MediaStreamConstraints,
  ): Promise<MediaStream> {
    const userGestureMayStartNewCall =
      callHasEnded && Date.now() <= postCallUserGestureUntil;

    if (callHasEnded && !userGestureMayStartNewCall) {
      blockedPostCallMediaRequests++;
      scheduleCallWindowState("post-call-media-request-blocked");
      const error = new Error(
        "Media capture is unavailable after the call has ended",
      );
      error.name = "AbortError";
      throw error;
    }

    if (userGestureMayStartNewCall) {
      callHasEnded = false;
      postCallUserGestureUntil = 0;
      scheduleCallWindowState("user-started-next-call");
    }

    const stream = await originalGetUserMedia(constraints);
    if (callHasEnded) {
      blockedPostCallMediaRequests++;
      stopStreamTracks(stream, "call ended while media request was pending");
      scheduleCallWindowState("pending-media-request-stopped-after-call-end");
      const error = new Error(
        "Media capture completed after the call had already ended",
      );
      error.name = "AbortError";
      throw error;
    }

    activeStreams.add(stream);
    return stream;
  }

  try {
    mediaDevices.getUserMedia = guardedGetUserMedia;
  } catch {
    try {
      Object.defineProperty(mediaDevices, "getUserMedia", {
        configurable: true,
        value: guardedGetUserMedia,
      });
    } catch {
      console.warn("[Call Window] Could not install media capture guard");
    }
  }

  function emitCallWindowState(reason: string): void {
    const controls = Array.from(
      document.querySelectorAll('button, [role="button"], a[role="button"]'),
    );

    const isVisible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      if (node.closest('[aria-hidden="true"]') || node.closest("[hidden]")) {
        return false;
      }
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width >= 4 && rect.height >= 4;
    };

    const activeControlLabels = controls
      .filter((node) => isVisible(node))
      .map((node) =>
        String(
          node.getAttribute("aria-label") ||
            node.getAttribute("title") ||
            node.textContent ||
            "",
        )
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean)
      .filter((label) =>
        /\b(end call|hang up|leave call|disconnect|mute|unmute|turn off camera|turn on camera|speaker)\b/i.test(
          label,
        ),
      )
      .slice(0, 20);

    const statusText =
      String(document.body?.innerText || "")
        .replace(/\s+/g, " ")
        .match(
          /(ongoing call|calling|ringing|call ended|call declined|no answer|busy|answered elsewhere)/i,
        )?.[0] || null;

    const callWindowOpen =
      activeControlLabels.length > 0 ||
      Boolean(statusText && !/call ended/i.test(statusText));
    if (callWindowOpen) {
      hasSeenActiveCallUi = true;
    }

    const isMuted = activeControlLabels.some((label) =>
      label.toLowerCase().includes("unmute"),
    )
      ? true
      : activeControlLabels.some((label) =>
            label.toLowerCase().includes("mute"),
          )
        ? false
        : null;

    const payload = {
      reason,
      callWindowOpen,
      isMuted,
      popupVsMainWindow: "child-window",
      activeControlLabels,
      statusText,
      mediaGuardState: callHasEnded ? "ended" : "active",
      blockedPostCallMediaRequests,
      url: window.location.href,
      title: document.title,
      timestamp: Date.now(),
    };

    const signature = JSON.stringify(payload);
    if (signature === lastCallWindowStateSignature) {
      return;
    }
    lastCallWindowStateSignature = signature;

    try {
      window.postMessage({ type: "md-call-window-state", payload }, "*");
    } catch {
      // Ignore postMessage failures
    }
  }

  function scheduleCallWindowState(reason: string): void {
    if (callWindowStateTimer !== null) {
      window.clearTimeout(callWindowStateTimer);
    }
    callWindowStateTimer = window.setTimeout(() => {
      callWindowStateTimer = null;
      emitCallWindowState(reason);
    }, 0);
  }

  /**
   * Intercept RTCPeerConnection to track media streams
   * This catches streams that were created before our injection
   */
  const OriginalRTCPeerConnection = window.RTCPeerConnection;

  (window as any).RTCPeerConnection = function (config?: RTCConfiguration) {
    const pc = new OriginalRTCPeerConnection(config);
    activePeerConnections.add(pc);

    // Track streams when tracks are added
    const originalAddTrack = pc.addTrack.bind(pc);
    pc.addTrack = function (
      track: MediaStreamTrack,
      ...streams: MediaStream[]
    ) {
      streams.forEach((s) => activeStreams.add(s));
      return originalAddTrack(track, ...streams);
    };

    // Track remote streams
    pc.addEventListener("track", (event) => {
      event.streams.forEach((s) => activeStreams.add(s));
    });

    pc.addEventListener("connectionstatechange", () => {
      if (
        pc.connectionState === "closed" ||
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected"
      ) {
        activePeerConnections.delete(pc);
      }
    });

    pc.addEventListener("signalingstatechange", () => {
      if (pc.signalingState === "closed") {
        activePeerConnections.delete(pc);
      }
    });

    return pc;
  };
  (window as any).RTCPeerConnection.prototype =
    OriginalRTCPeerConnection.prototype;

  /**
   * Scan DOM for audio/video elements with MediaStreams
   */
  function scanForMediaStreams(): MediaStream[] {
    const streams: MediaStream[] = [];
    document.querySelectorAll("audio, video").forEach((el) => {
      const mediaEl = el as HTMLMediaElement;
      if (mediaEl.srcObject instanceof MediaStream) {
        streams.push(mediaEl.srcObject);
      }
    });
    return streams;
  }

  /**
   * Stop all media tracks from all sources
   */
  function stopAllMediaTracks(_reason: string): void {
    let tracksStopped = 0;

    // 1. Stop tracked streams from RTCPeerConnection
    activeStreams.forEach((stream) => {
      tracksStopped += stopStreamTracks(stream, _reason);
    });
    activeStreams.clear();

    // 2. Scan DOM for any streams we missed
    scanForMediaStreams().forEach((stream) => {
      tracksStopped += stopStreamTracks(stream, _reason);
    });

    // 3. Stop tracks directly from active peer connections.
    activePeerConnections.forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        const track = sender.track;
        if (track && track.readyState !== "ended") {
          track.stop();
          tracksStopped++;
        }
      });

      pc.getReceivers().forEach((receiver) => {
        const track = receiver.track;
        if (track && track.readyState !== "ended") {
          track.stop();
          tracksStopped++;
        }
      });
    });

    if (tracksStopped > 0) {
      console.log(`[Call Window] Released ${tracksStopped} media tracks`);
    } else {
      console.log(
        `[Call Window] No tracked media remained to release (${_reason})`,
      );
    }
  }

  // Expose cleanup function globally
  (window as any).__stopAllMediaTracks = stopAllMediaTracks;

  /**
   * Detect call ended via DOM observation
   */
  const callEndedPatterns = [
    /call ended/i,
    /call has ended/i,
    /no answer/i,
    /didn't answer/i,
    /unavailable/i,
    /couldn't connect/i,
    /call declined/i,
    /busy/i,
    /redial/i,
    /how was the quality/i,
  ];

  let hasDetectedCallEnd = false;

  function hasCallEndedSignal(text: string): boolean {
    const normalized = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return false;
    return callEndedPatterns.some((p) => p.test(normalized));
  }

  function handleCallEnded(): void {
    if (hasDetectedCallEnd) return;
    if (!hasSeenActiveCallUi) return;
    hasDetectedCallEnd = true;
    callHasEnded = true;
    postCallUserGestureUntil = 0;

    emitCallWindowState("call-ended");
    stopAllMediaTracks("call ended");

    // Reset after delay for multiple calls in same window
    setTimeout(() => {
      hasDetectedCallEnd = false;
    }, 5000);
  }

  mediaDevices.addEventListener("devicechange", () => {
    if (!callHasEnded) return;

    for (const delay of [0, 100, 500]) {
      window.setTimeout(() => {
        if (!callHasEnded) return;
        stopAllMediaTracks("device changed after call ended");
        scheduleCallWindowState("post-call-device-change");
      }, delay);
    }
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!callHasEnded || event.isTrusted === false) return;
      // A short, user-gesture-scoped window lets the existing call surface
      // start a deliberate redial without re-enabling device-change capture.
      postCallUserGestureUntil = Date.now() + 3000;
    },
    { capture: true },
  );

  // Observe DOM for call-ended indicators
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const text = (node as Element).textContent || "";
            if (hasCallEndedSignal(text)) {
              handleCallEnded();
              return;
            }
          } else if (node.nodeType === Node.TEXT_NODE) {
            if (hasCallEndedSignal(node.nodeValue || "")) {
              handleCallEnded();
              return;
            }
          }
        }
      }

      if (mutation.type === "characterData") {
        const node = mutation.target;
        if (node.nodeType === Node.TEXT_NODE) {
          if (hasCallEndedSignal(node.nodeValue || "")) {
            handleCallEnded();
            return;
          }
          const parentText = node.parentElement?.textContent || "";
          if (hasCallEndedSignal(parentText)) {
            handleCallEnded();
            return;
          }
        }
      }
    }

    scheduleCallWindowState("mutation");
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      scheduleCallWindowState("domcontentloaded");
    });
  }

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const label = String(
        target
          .closest('button, [role="button"], a[role="button"]')
          ?.getAttribute("aria-label") ||
          target.textContent ||
          "",
      )
        .replace(/\s+/g, " ")
        .trim();
      if (!/\b(?:mute|unmute)\b/i.test(label)) return;
      scheduleCallWindowState("mute-toggle-click");
    },
    { capture: true },
  );

  scheduleCallWindowState("injected");

  // Cleanup on window close
  window.addEventListener("beforeunload", () => {
    stopAllMediaTracks("window closing");
  });

  window.addEventListener("pagehide", () => {
    stopAllMediaTracks("page hide");
  });
})();

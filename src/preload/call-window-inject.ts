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

  // Store original getUserMedia for nuclear option
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices,
  );

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
    pc.addEventListener('track', (event) => {
      event.streams.forEach((s) => activeStreams.add(s));
    });

    pc.addEventListener('connectionstatechange', () => {
      if (
        pc.connectionState === 'closed' ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected'
      ) {
        activePeerConnections.delete(pc);
      }
    });

    pc.addEventListener('signalingstatechange', () => {
      if (pc.signalingState === 'closed') {
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
    document.querySelectorAll('audio, video').forEach((el) => {
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
      stream.getTracks().forEach((track) => {
        if (track.readyState !== 'ended') {
          track.stop();
          tracksStopped++;
        }
      });
    });
    activeStreams.clear();

    // 2. Scan DOM for any streams we missed
    scanForMediaStreams().forEach((stream) => {
      stream.getTracks().forEach((track) => {
        if (track.readyState !== 'ended') {
          track.stop();
          tracksStopped++;
        }
      });
    });

    // 3. Stop tracks directly from active peer connections.
    activePeerConnections.forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        const track = sender.track;
        if (track && track.readyState !== 'ended') {
          track.stop();
          tracksStopped++;
        }
      });

      pc.getReceivers().forEach((receiver) => {
        const track = receiver.track;
        if (track && track.readyState !== 'ended') {
          track.stop();
          tracksStopped++;
        }
      });
    });

    // 4. Nuclear option: Get fresh mic access and immediately release
    // This forces the browser to release any microphone that might be stuck
    if (tracksStopped === 0) {
      originalGetUserMedia({ audio: true })
        .then((stream) => {
          stream.getTracks().forEach((track) => {
            console.log(
              `[Call Window] Releasing microphone: ${track.label}`,
            );
            track.stop();
          });
        })
        .catch(() => {
          // Fine - might mean no active audio or permission issue
        });
    } else {
      console.log(`[Call Window] Released ${tracksStopped} media tracks`);
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
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    return callEndedPatterns.some((p) => p.test(normalized));
  }

  function handleCallEnded(): void {
    if (hasDetectedCallEnd) return;
    hasDetectedCallEnd = true;

    stopAllMediaTracks('call ended');

    // Reset after delay for multiple calls in same window
    setTimeout(() => {
      hasDetectedCallEnd = false;
    }, 5000);
  }

  // Observe DOM for call-ended indicators
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const text = (node as Element).textContent || '';
            if (hasCallEndedSignal(text)) {
              handleCallEnded();
              return;
            }
          } else if (node.nodeType === Node.TEXT_NODE) {
            if (hasCallEndedSignal(node.nodeValue || '')) {
              handleCallEnded();
              return;
            }
          }
        }
      }

      if (mutation.type === 'characterData') {
        const node = mutation.target;
        if (node.nodeType === Node.TEXT_NODE) {
          if (hasCallEndedSignal(node.nodeValue || '')) {
            handleCallEnded();
            return;
          }
          const parentText = node.parentElement?.textContent || '';
          if (hasCallEndedSignal(parentText)) {
            handleCallEnded();
            return;
          }
        }
      }
    }
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
  }

  // Cleanup on window close
  window.addEventListener('beforeunload', () => {
    stopAllMediaTracks('window closing');
  });

  window.addEventListener('pagehide', () => {
    stopAllMediaTracks('page hide');
  });
})();

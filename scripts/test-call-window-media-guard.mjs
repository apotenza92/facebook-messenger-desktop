import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "src/preload/call-window-inject.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.None,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: sourcePath,
}).outputText;

class FakeTrack {
  constructor(kind = "audio") {
    this.kind = kind;
    this.label = `${kind}-device`;
    this.readyState = "live";
  }

  stop() {
    this.readyState = "ended";
  }
}

class FakeMediaStream {
  constructor(tracks = [new FakeTrack()]) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }
}

class FakeElement {
  constructor(label = "") {
    this.label = label;
    this.textContent = label;
    this.parentElement = null;
  }

  closest() {
    return this;
  }

  getAttribute(name) {
    return name === "aria-label" ? this.label : null;
  }
}

class FakeHTMLElement extends FakeElement {
  getBoundingClientRect() {
    return { width: 40, height: 20 };
  }
}

class FakeRTCPeerConnection {
  constructor() {
    this.connectionState = "new";
    this.signalingState = "stable";
    this.senders = [];
    this.receivers = [];
  }

  addTrack(track, ...streams) {
    this.senders.push({ track });
    return { streams };
  }

  addEventListener() {}

  getSenders() {
    return this.senders;
  }

  getReceivers() {
    return this.receivers;
  }
}

const windowListeners = new Map();
const documentListeners = new Map();
const mediaDeviceListeners = new Map();
const postedMessages = [];
const createdStreams = [];
let getUserMediaCalls = 0;
let mutationCallback = null;

const mediaDevices = {
  async getUserMedia() {
    getUserMediaCalls += 1;
    const stream = new FakeMediaStream();
    createdStreams.push(stream);
    return stream;
  },
  addEventListener(type, listener) {
    mediaDeviceListeners.set(type, listener);
  },
};

const activeControl = new FakeHTMLElement("Mute microphone");
const document = {
  body: {
    innerText: "Ongoing call",
  },
  querySelectorAll(selector) {
    if (selector === "audio, video") return [];
    return [activeControl];
  },
  addEventListener(type, listener) {
    documentListeners.set(type, listener);
  },
};

const windowObject = {
  RTCPeerConnection: FakeRTCPeerConnection,
  location: { href: "https://www.messenger.com/call" },
  setTimeout,
  clearTimeout,
  getComputedStyle() {
    return { display: "block", visibility: "visible" };
  },
  postMessage(message) {
    postedMessages.push(message);
  },
  addEventListener(type, listener) {
    windowListeners.set(type, listener);
  },
};

class FakeMutationObserver {
  constructor(callback) {
    mutationCallback = callback;
  }

  observe() {}
}

const context = vm.createContext({
  console: {
    log() {},
  },
  document,
  window: windowObject,
  navigator: { mediaDevices },
  MutationObserver: FakeMutationObserver,
  MediaStream: FakeMediaStream,
  MediaStreamTrack: FakeTrack,
  RTCPeerConnection: FakeRTCPeerConnection,
  Element: FakeElement,
  HTMLElement: FakeHTMLElement,
  Node: {
    ELEMENT_NODE: 1,
    TEXT_NODE: 3,
  },
  setTimeout,
  clearTimeout,
});

vm.runInContext(compiled, context, { filename: sourcePath });
await new Promise((resolve) => setTimeout(resolve, 5));

assert.equal(
  typeof mutationCallback,
  "function",
  "call-window injection should observe call lifecycle mutations",
);
assert(
  postedMessages.some(
    (message) =>
      message?.type === "md-call-window-state" &&
      message?.payload?.callWindowOpen === true,
  ),
  "active call UI should be observed before accepting a call-ended signal",
);

document.body.innerText = "Call ended";
mutationCallback([
  {
    type: "childList",
    addedNodes: [
      {
        nodeType: 3,
        nodeValue: "Call ended",
      },
    ],
  },
]);
await new Promise((resolve) => setTimeout(resolve, 5));

assert.equal(
  getUserMediaCalls,
  0,
  "ending a call must never request fresh microphone access as a cleanup technique",
);

let postCallStream = null;
let postCallRequestRejected = false;
try {
  postCallStream = await mediaDevices.getUserMedia({ audio: true });
} catch (error) {
  postCallRequestRejected = error?.name === "AbortError";
}

assert(
  postCallRequestRejected ||
    postCallStream?.getTracks().every((track) => track.readyState === "ended"),
  "media requested after the call-ended boundary must be rejected or stopped",
);
assert.equal(
  getUserMediaCalls,
  0,
  "a blocked post-call request must not reach the browser microphone API",
);

assert.equal(
  typeof mediaDeviceListeners.get("devicechange"),
  "function",
  "the post-call media guard should observe device changes",
);

const callsBeforeDeviceChange = getUserMediaCalls;
mediaDeviceListeners.get("devicechange")();
await new Promise((resolve) => setTimeout(resolve, 550));
assert.equal(
  getUserMediaCalls,
  callsBeforeDeviceChange,
  "a post-call device change must not request microphone access",
);

assert.equal(
  typeof documentListeners.get("pointerdown"),
  "function",
  "the post-call media guard should observe deliberate user gestures",
);
documentListeners.get("pointerdown")({ isTrusted: true });
const redialStream = await mediaDevices.getUserMedia({ audio: true });
assert(
  redialStream.getTracks().every((track) => track.readyState === "live"),
  "a user-initiated redial should be allowed to acquire live media",
);

console.log("call-window post-call media guard tests passed");

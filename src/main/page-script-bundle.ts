import * as fs from "fs";
import * as path from "path";

// Scripts injected into the Messenger page's main world after each load,
// in dependency order. Paths are relative to the compiled dist/main folder.
// Shared modules compiled as CommonJS need their export statements removed
// before they can run as plain page scripts.
export const PAGE_SCRIPT_SOURCES: ReadonlyArray<{
  label: string;
  relativePath: string;
  sanitizeCommonJsExports: boolean;
  // Only injected when the notification diagnostics probe is enabled.
  probeOnly?: boolean;
}> = [
  {
    label: "notification activity policy",
    relativePath: "../shared/notification-activity-policy.js",
    sanitizeCommonJsExports: true,
  },
  {
    label: "incoming-call evidence",
    relativePath: "../shared/incoming-call-evidence.js",
    sanitizeCommonJsExports: true,
  },
  {
    label: "notification display policy",
    relativePath: "../preload/notification-display-policy.js",
    sanitizeCommonJsExports: false,
  },
  {
    label: "notification text policy",
    relativePath: "../preload/notification-text-policy.js",
    sanitizeCommonJsExports: false,
  },
  {
    label: "notification decision policy",
    relativePath: "../preload/notification-decision-policy.js",
    sanitizeCommonJsExports: false,
  },
  {
    label: "in-page notification diagnostics",
    relativePath: "../preload/in-page-notification-diagnostics.js",
    sanitizeCommonJsExports: true,
  },
  {
    label: "notification diagnostics probe",
    relativePath: "../preload/notification-probe-inject.js",
    sanitizeCommonJsExports: false,
    probeOnly: true,
  },
  {
    label: "notification override",
    relativePath: "../preload/notifications-inject.js",
    sanitizeCommonJsExports: false,
  },
];

export const preparePageScript = (
  source: string,
  sanitizeCommonJsExports: boolean,
): string => {
  const script = sanitizeCommonJsExports
    ? source
        .replace(
          /^Object\.defineProperty\(exports,\s*"__esModule",\s*\{\s*value:\s*true\s*\}\);\s*$/m,
          "",
        )
        .replace(/^exports\.[^=]+=\s*[^;]+;\s*$/gm, "")
    : source;
  return `(() => {\n${script}\n})();`;
};

// Installs the page-side bridge the injected scripts post notifications
// through, and tells them whether debug logging is enabled.
export const buildPageBridgePrelude = (
  debugLogging: boolean,
  probeSalt: string | null = null,
): string => `
  (function() {
    window.__mdNotificationDebugLogging = ${JSON.stringify(debugLogging)};
    ${probeSalt ? `window.__mdNotificationProbeSalt = ${JSON.stringify(probeSalt)};` : ""}
    window.__electronNotificationBridge = function(data) {
      const event = new CustomEvent('electron-notification', { detail: data });
      window.dispatchEvent(event);
    };
    window.addEventListener('electron-notification', function(event) {
      window.postMessage({ type: 'electron-notification', data: event.detail }, '*');
    });
  })();
`;

export type PreparedPageScript = {
  label: string;
  scriptPath: string;
  code: string | null;
};

const preparedScriptCache = new Map<string, PreparedPageScript[]>();

// Reads and prepares the page scripts once per process; they only change
// when the app is rebuilt.
export const loadPreparedPageScripts = (
  mainDistDir: string,
  options: { includeProbe?: boolean } = {},
): PreparedPageScript[] => {
  const cacheKey = `${mainDistDir}|${options.includeProbe ? "probe" : "plain"}`;
  const cached = preparedScriptCache.get(cacheKey);
  if (cached) return cached;

  const sources = PAGE_SCRIPT_SOURCES.filter(
    (entry) => options.includeProbe || !entry.probeOnly,
  );
  const prepared = sources.map((entry) => {
    const scriptPath = path.join(mainDistDir, entry.relativePath);
    let code: string | null = null;
    try {
      code = preparePageScript(
        fs.readFileSync(scriptPath, "utf8"),
        entry.sanitizeCommonJsExports,
      );
    } catch {
      code = null;
    }
    return { label: entry.label, scriptPath, code };
  });

  if (prepared.every((entry) => entry.code !== null)) {
    preparedScriptCache.set(cacheKey, prepared);
  }
  return prepared;
};

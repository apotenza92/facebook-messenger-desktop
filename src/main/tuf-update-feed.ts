import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { BaseFetcher, Updater } from "tuf-js";
import { DownloadHTTPError } from "tuf-js/dist/error";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_FETCH_ATTEMPTS = 4;
const FETCH_TIMEOUT_MS = 20_000;

export type TufVerifiedUpdateFeed = {
  close: () => Promise<void>;
  feedUrl: string;
  refresh: () => Promise<string>;
  targetPath: string;
  trustInitialized: boolean;
  trustedRootPath: string;
};

type CreateTufVerifiedUpdateFeedInput = {
  allowLoopbackHttp?: boolean;
  embeddedRootPath: string;
  repositoryUrl: string;
  targetName: string;
  trustDir: string;
  UpdaterClass?: typeof Updater;
};

type InitializeTrustedRootInput = {
  embeddedRootPath: string;
  metadataDir: string;
};

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

export function validateTufRepositoryUrl(
  value: string,
  options: { allowLoopbackHttp?: boolean } = {},
): string {
  const parsed = new URL(value);
  const loopbackHttp =
    options.allowLoopbackHttp === true &&
    parsed.protocol === "http:" &&
    isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    throw new Error(
      "Messenger TUF repositories must use HTTPS; loopback HTTP is test-only.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Messenger TUF repository URLs cannot contain credentials or query data.");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function validateTufTargetName(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== path.posix.basename(value) ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`Unsafe Messenger TUF update target name: ${value}`);
  }
  return value;
}

function isRegularFile(filePath: string): boolean {
  try {
    const entry = fs.lstatSync(filePath);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

export function initializeTrustedRoot({
  embeddedRootPath,
  metadataDir,
}: InitializeTrustedRootInput): {
  initialized: boolean;
  trustedRootPath: string;
} {
  const trustedRootPath = path.join(metadataDir, "root.json");
  fs.mkdirSync(metadataDir, { recursive: true, mode: 0o700 });

  if (fs.existsSync(trustedRootPath)) {
    if (!isRegularFile(trustedRootPath)) {
      throw new Error("The persisted Messenger TUF root is not a regular file.");
    }
    return { initialized: false, trustedRootPath };
  }

  if (!isRegularFile(embeddedRootPath)) {
    throw new Error("Messenger has no embedded TUF trust root.");
  }

  fs.copyFileSync(
    embeddedRootPath,
    trustedRootPath,
    fs.constants.COPYFILE_EXCL,
  );
  fs.chmodSync(trustedRootPath, 0o600);
  return { initialized: true, trustedRootPath };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class StrictTufFetcher extends BaseFetcher {
  private readonly repository: URL;

  constructor(repositoryUrl: string) {
    super();
    this.repository = new URL(repositoryUrl);
  }

  private validateResourceUrl(value: string): URL {
    const parsed = new URL(value);
    if (
      parsed.protocol !== this.repository.protocol ||
      parsed.origin !== this.repository.origin
    ) {
      throw new Error("Messenger TUF metadata escaped its configured repository.");
    }

    const repositoryPath = this.repository.pathname.replace(/\/$/, "");
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(parsed.pathname);
    } catch {
      throw new Error("Messenger TUF metadata URL contains invalid encoding.");
    }
    if (
      decodedPath.includes("\\") ||
      decodedPath.split("/").includes("..") ||
      !(
        decodedPath.startsWith(`${repositoryPath}/metadata/`) ||
        decodedPath.startsWith(`${repositoryPath}/targets/`)
      )
    ) {
      throw new Error("Messenger TUF metadata URL is outside the repository boundary.");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Messenger TUF metadata URL contains unexpected components.");
    }
    return parsed;
  }

  private requestOnce(resource: URL): Promise<NodeJS.ReadableStream> {
    const client = resource.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const request = client.get(
        resource,
        {
          headers: {
            Accept: "application/json, application/octet-stream",
            "User-Agent": "Messenger desktop TUF updater",
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            response.resume();
            reject(
              new Error(
                `Messenger TUF metadata redirect rejected with status ${status}.`,
              ),
            );
            return;
          }
          if (status !== 200) {
            response.resume();
            const error = new DownloadHTTPError(
              "Messenger TUF metadata download failed.",
              status,
            ) as DownloadHTTPError & { retryable?: boolean };
            error.retryable = status >= 500 && status < 600;
            reject(error);
            return;
          }
          resolve(response);
        },
      );
      request.setTimeout(FETCH_TIMEOUT_MS, () => {
        request.destroy(new Error("Messenger TUF metadata request timed out."));
      });
      request.on("error", reject);
    });
  }

  async fetch(value: string): Promise<NodeJS.ReadableStream> {
    const resource = this.validateResourceUrl(value);
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestOnce(resource);
      } catch (error) {
        lastError = error;
        const retryable =
          (error as { retryable?: boolean })?.retryable === true ||
          /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
            String((error as Error)?.message || error),
          );
        if (!retryable || attempt === MAX_FETCH_ATTEMPTS) {
          throw error;
        }
        await delay(attempt * 250);
      }
    }
    throw lastError;
  }
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function createTufVerifiedUpdateFeed({
  allowLoopbackHttp = false,
  embeddedRootPath,
  repositoryUrl,
  targetName,
  trustDir,
  UpdaterClass = Updater,
}: CreateTufVerifiedUpdateFeedInput): Promise<TufVerifiedUpdateFeed> {
  const normalizedRepositoryUrl = validateTufRepositoryUrl(repositoryUrl, {
    allowLoopbackHttp,
  });
  const normalizedTargetName = validateTufTargetName(targetName);
  const metadataDir = path.join(trustDir, "metadata");
  const targetDir = path.join(trustDir, "targets");
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const trust = initializeTrustedRoot({ embeddedRootPath, metadataDir });
  const targetPath = path.join(targetDir, normalizedTargetName);

  let targetBytes: Buffer | null = null;
  let refreshPromise: Promise<string> | null = null;
  const refresh = (): Promise<string> => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const updater = new UpdaterClass({
        metadataBaseUrl: `${normalizedRepositoryUrl}/metadata`,
        targetBaseUrl: `${normalizedRepositoryUrl}/targets`,
        metadataDir,
        targetDir,
        fetcher: new StrictTufFetcher(normalizedRepositoryUrl),
        config: {
          fetchTimeout: FETCH_TIMEOUT_MS,
          fetchRetries: 0,
        },
      });
      await updater.refresh();
      const targetInfo = await updater.getTargetInfo(normalizedTargetName);
      if (!targetInfo) {
        throw new Error(
          `The signed Messenger update repository has no ${normalizedTargetName} target.`,
        );
      }
      const temporaryTargetPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await updater.downloadTarget(targetInfo, temporaryTargetPath);
        fs.renameSync(temporaryTargetPath, targetPath);
        fs.chmodSync(targetPath, 0o600);
      } finally {
        fs.rmSync(temporaryTargetPath, { force: true });
      }
      targetBytes = fs.readFileSync(targetPath);
      return targetPath;
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  };
  await refresh();

  const requestPath = `/${encodeURIComponent(normalizedTargetName)}`;
  const server = http.createServer((request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (
      !request.method ||
      !["GET", "HEAD"].includes(request.method) ||
      pathname !== requestPath
    ) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end();
      return;
    }
    if (!targetBytes) {
      response.writeHead(503, { "Cache-Control": "no-store" }).end();
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": targetBytes.length,
      "Content-Type": "application/yaml",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : targetBytes);
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("Messenger could not start its verified local update feed.");
  }

  let closePromise: Promise<void> | null = null;
  const closeFeed = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = server.listening ? close(server) : Promise.resolve();
    return closePromise;
  };

  return {
    close: closeFeed,
    feedUrl: `http://127.0.0.1:${address.port}`,
    refresh,
    targetPath,
    trustInitialized: trust.initialized,
    trustedRootPath: trust.trustedRootPath,
  };
}

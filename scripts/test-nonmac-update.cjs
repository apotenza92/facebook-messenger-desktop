#!/usr/bin/env node

const { createHash, randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");
const yaml = require("js-yaml");
const {
  signUpdateRepository,
} = require("./sign-tuf-update-repository.cjs");

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function digest(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function artifactName(value) {
  if (typeof value !== "string" || !value) {
    throw new Error("Updater metadata has no artifact URL.");
  }
  const candidate = /^https?:\/\//.test(value)
    ? new URL(value).pathname
    : value;
  const name = decodeURIComponent(path.posix.basename(candidate));
  if (!name || name.includes("\\") || name !== path.posix.basename(name)) {
    throw new Error(`Unsafe updater artifact name: ${value}`);
  }
  return name;
}

function serveFile(request, response, filePath) {
  const bytes = fs.readFileSync(filePath);
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!range) {
    response.writeHead(200, {
      "Accept-Ranges": "bytes",
      "Content-Length": bytes.length,
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
    return;
  }
  const start = Number(range[1]);
  const end = range[2]
    ? Math.min(Number(range[2]), bytes.length - 1)
    : bytes.length - 1;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > end ||
    start >= bytes.length
  ) {
    response
      .writeHead(416, { "Content-Range": `bytes */${bytes.length}` })
      .end();
    return;
  }
  response.writeHead(206, {
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
  });
  response.end(
    request.method === "HEAD" ? undefined : bytes.subarray(start, end + 1),
  );
}

async function createServer({
  candidateDirectory,
  candidateMetadata,
  mode,
  privateBundle,
  rootPath,
  targetName,
  temporary,
}) {
  const requests = [];
  let repositoryDirectory;
  let servedTarget;
  const artifacts = new Map();
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://127.0.0.1").pathname,
    );
    requests.push(pathname);
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    const metadataMatch = pathname.match(/^\/tuf\/metadata\/([^/]+)$/);
    if (metadataMatch) {
      const filePath = path.join(
        repositoryDirectory,
        "metadata",
        metadataMatch[1],
      );
      if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        response.writeHead(404).end();
        return;
      }
      serveFile(request, response, filePath);
      return;
    }
    if (pathname === `/tuf/targets/${encodeURIComponent(targetName)}`) {
      const bytes =
        mode === "corrupt-target"
          ? Buffer.from("corrupt updater metadata")
          : servedTarget;
      response.writeHead(200, { "Content-Length": bytes.length });
      response.end(request.method === "HEAD" ? undefined : bytes);
      return;
    }
    const assetMatch = pathname.match(/^\/assets\/([^/]+)$/);
    if (assetMatch && artifacts.has(assetMatch[1])) {
      serveFile(request, response, artifacts.get(assetMatch[1]));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not create native updater test server.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const document = yaml.load(fs.readFileSync(candidateMetadata, "utf8"));
  document.files = document.files.map((file) => {
    const name = artifactName(file.url);
    const artifactPath = path.join(candidateDirectory, name);
    if (!fs.statSync(artifactPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Candidate updater artifact is missing: ${name}`);
    }
    artifacts.set(name, artifactPath);
    return { ...file, url: `${baseUrl}/assets/${encodeURIComponent(name)}` };
  });
  if (document.path) {
    document.path =
      `${baseUrl}/assets/${encodeURIComponent(artifactName(document.path))}`;
  }
  servedTarget = Buffer.from(
    `${yaml.dump(document, { lineWidth: -1, noRefs: true }).trimEnd()}\n`,
  );
  const inputPath = path.join(temporary, `${mode}-target.yml`);
  fs.writeFileSync(inputPath, servedTarget);
  repositoryDirectory = path.join(temporary, `${mode}-repository`);
  signUpdateRepository({
    now: new Date(),
    outputDirectory: repositoryDirectory,
    previousMetadataDirectory: null,
    privateKeys: Object.fromEntries(
      ["targets", "snapshot", "timestamp"].map((role) => [
        role,
        privateBundle.roles[role].private_key_pem,
      ]),
    ),
    rootPath,
    targetName,
    targetPath: inputPath,
  });
  if (mode === "wrong-signature") {
    const targetsPath = path.join(
      repositoryDirectory,
      "metadata",
      "targets.json",
    );
    const targets = JSON.parse(fs.readFileSync(targetsPath, "utf8"));
    targets.signed.version += 1;
    fs.writeFileSync(targetsPath, JSON.stringify(targets));
  }
  return {
    baseUrl,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    requests,
    version: document.version,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}.`);
  }
}

function readEvents(resultPath) {
  if (!fs.existsSync(resultPath)) return [];
  return fs
    .readFileSync(resultPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

async function waitForEvent(resultPath, names, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = readEvents(resultPath).find((entry) =>
      names.has(entry.event),
    );
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${[...names].join(" or ")}.`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    once(child, "exit").catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
}

function stopWindowsProcesses(pids) {
  if (process.platform !== "win32") return;
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
  }
}

async function removeDirectoryWithRetries(directory) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

function installedVersion(executable) {
  const archivePath = path.join(
    path.dirname(executable),
    "resources",
    "app.asar",
  );
  asar.uncache(archivePath);
  return JSON.parse(asar.extractFile(archivePath, "package.json")).version;
}

async function waitForReplacement({
  candidateArtifact,
  candidateAppAsar,
  candidateVersion,
  executable,
  previousArtifact,
}) {
  const expectedDigest = digest(candidateArtifact);
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      if (process.platform === "win32") {
        if (
          installedVersion(executable) === candidateVersion &&
          digest(
            path.join(
              path.dirname(executable),
              "resources",
              "app.asar",
            ),
          ) === digest(candidateAppAsar)
        ) {
          return;
        }
      } else if (digest(previousArtifact) === expectedDigest) {
        return;
      }
    } catch {
      // The installer can temporarily remove or lock the package.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for native candidate replacement.");
}

function launch(executable, env, logPath, userDataDirectory) {
  const args =
    process.platform === "linux"
      ? ["--no-sandbox"]
      : [`--user-data-dir=${userDataDirectory}`];
  const log = fs.openSync(logPath, "a", 0o600);
  return spawn(executable, args, {
    env,
    stdio: ["ignore", log, log],
    windowsHide: true,
  }).once("exit", () => fs.closeSync(log));
}

async function main(argv = process.argv.slice(2)) {
  if (!["win32", "linux"].includes(process.platform)) {
    throw new Error("Native updater audit requires Windows or Linux.");
  }
  const arch = option(argv, "--arch");
  const previousArtifact = path.resolve(
    option(argv, "--previous-artifact"),
  );
  const candidateArtifact = path.resolve(
    option(argv, "--candidate-artifact"),
  );
  const candidateAppAsarValue = option(argv, "--candidate-app-asar");
  const candidateAppAsar = candidateAppAsarValue
    ? path.resolve(candidateAppAsarValue)
    : null;
  const candidateDirectory = path.resolve(
    option(argv, "--candidate-directory"),
  );
  const candidateMetadata = path.resolve(
    option(argv, "--candidate-metadata"),
  );
  const channel = option(argv, "--channel");
  const evidenceDirectory = path.resolve(option(argv, "--evidence"));
  const privateBundlePath = path.resolve(
    option(argv, "--private-key-bundle"),
  );
  const rootPath = path.resolve(option(argv, "--root"));
  const targetName = option(argv, "--target-name");
  if (arch !== process.arch) {
    throw new Error(`Expected native ${arch}; running ${process.arch}.`);
  }
  if (!["stable", "beta"].includes(channel)) {
    throw new Error(`Expected stable or beta channel; received ${channel}.`);
  }
  if (process.platform === "win32" && !candidateAppAsar) {
    throw new Error("Windows updater audit requires --candidate-app-asar.");
  }
  const privateBundle = JSON.parse(
    fs.readFileSync(privateBundlePath, "utf8"),
  );
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "messenger-native-updater-"),
  );
  fs.mkdirSync(evidenceDirectory, { recursive: false });

  let executable = previousArtifact;
  let installDirectory = null;
  let primaryError = null;
  const observedPids = new Set();
  const productName = channel === "beta" ? "Messenger Beta" : "Messenger";
  try {
    if (process.platform === "win32") {
      installDirectory = path.join(temporary, "installed");
      run(previousArtifact, ["/S", `/D=${installDirectory}`]);
      executable = path.join(installDirectory, `${productName}.exe`);
      if (!fs.existsSync(executable)) {
        throw new Error(`Previous Windows executable missing: ${executable}`);
      }
    } else {
      fs.chmodSync(previousArtifact, 0o755);
    }
    const beforeDigest =
      process.platform === "win32"
        ? digest(
            path.join(installDirectory, "resources", "app.asar"),
          )
        : digest(previousArtifact);
    const candidateVersion = yaml.load(
      fs.readFileSync(candidateMetadata, "utf8"),
    ).version;
    const marker = randomUUID();

    for (const mode of [
      "corrupt-target",
      "wrong-signature",
      "valid",
    ]) {
      const server = await createServer({
        candidateDirectory,
        candidateMetadata,
        mode,
        privateBundle,
        rootPath,
        targetName,
        temporary,
      });
      const scenarioRoot = path.join(temporary, mode);
      fs.mkdirSync(scenarioRoot, { recursive: true });
      const resultPath = path.join(scenarioRoot, "events.json");
      const logPath = path.join(scenarioRoot, "runtime.log");
      const userDataDirectory = path.join(scenarioRoot, "userdata");
      const env = {
        ...process.env,
        APPDATA:
          process.platform === "win32"
            ? path.join(scenarioRoot, "appdata")
            : process.env.APPDATA,
        LOCALAPPDATA:
          process.platform === "win32"
            ? path.join(scenarioRoot, "localappdata")
            : process.env.LOCALAPPDATA,
        XDG_CONFIG_HOME:
          process.platform === "linux"
            ? path.join(scenarioRoot, "config")
            : process.env.XDG_CONFIG_HOME,
        MESSENGER_FORKED: "1",
        MESSENGER_UPDATE_E2E: "1",
        MESSENGER_UPDATE_E2E_EXPECTED_VERSION: candidateVersion,
        MESSENGER_UPDATE_E2E_INSTALL: mode === "valid" ? "1" : "0",
        MESSENGER_UPDATE_E2E_MARKER: marker,
        MESSENGER_UPDATE_E2E_APP_DATA_ROOT: scenarioRoot,
        MESSENGER_UPDATE_E2E_RESULT_PATH: resultPath,
        MESSENGER_UPDATE_E2E_TUF_REPOSITORY_URL: `${server.baseUrl}/tuf`,
      };
      if (process.platform === "linux") {
        env.APPIMAGE = previousArtifact;
      }
      let child = launch(executable, env, logPath, userDataDirectory);
      try {
        if (mode !== "valid") {
          await waitForEvent(resultPath, new Set(["error"]));
          const afterFailure =
            process.platform === "win32"
              ? digest(
                  path.join(installDirectory, "resources", "app.asar"),
                )
              : digest(previousArtifact);
          if (afterFailure !== beforeDigest) {
            throw new Error(`${mode} changed the installed package.`);
          }
        } else {
          await waitForEvent(resultPath, new Set(["update-downloaded"]));
          await waitForReplacement({
            candidateArtifact,
            candidateAppAsar,
            candidateVersion,
            executable,
            previousArtifact,
          });
          await stopProcess(child);
          child = launch(
            executable,
            {
              ...env,
              MESSENGER_UPDATE_E2E_MANUAL_LAUNCH: "1",
            },
            logPath,
            userDataDirectory,
          );
          const started = await waitForEvent(
            resultPath,
            new Set(["manual-runtime-started", "updated-runtime-started"]),
          );
          if (started.detail?.marker !== marker) {
            throw new Error("Updater did not preserve the user-data marker.");
          }
        }
      } finally {
        await stopProcess(child);
        await server.close();
        if (fs.existsSync(resultPath)) {
          for (const event of readEvents(resultPath)) {
            if (Number.isSafeInteger(event.detail?.pid)) {
              observedPids.add(event.detail.pid);
            }
          }
          fs.copyFileSync(
            resultPath,
            path.join(evidenceDirectory, `${mode}-events.jsonl`),
          );
        }
        if (fs.existsSync(logPath)) {
          fs.copyFileSync(
            logPath,
            path.join(evidenceDirectory, `${mode}-runtime.log`),
          );
        }
        fs.writeFileSync(
          path.join(evidenceDirectory, `${mode}-requests.txt`),
          `${server.requests.join("\n")}\n`,
        );
      }
    }
    fs.writeFileSync(
      path.join(evidenceDirectory, "RESULT.txt"),
      [
        `Platform: ${process.platform}`,
        `Architecture: ${arch}`,
        `Channel: ${channel}`,
        `Candidate version: ${candidateVersion}`,
        "Corrupt target: rejected without replacement",
        "Wrong signature: rejected without replacement",
        "Valid update: replaced and preserved user data",
        "",
      ].join("\n"),
    );
  } catch (error) {
    primaryError = error;
  } finally {
    stopWindowsProcesses(observedPids);
    if (
      process.platform === "win32" &&
      installDirectory &&
      fs.existsSync(
        path.join(installDirectory, `Uninstall ${productName}.exe`),
      )
    ) {
      spawnSync(
        path.join(installDirectory, `Uninstall ${productName}.exe`),
        ["/S"],
        { stdio: "ignore" },
      );
    }
    try {
      await removeDirectoryWithRetries(temporary);
    } catch (cleanupError) {
      if (!primaryError && process.platform !== "win32") {
        primaryError = cleanupError;
      } else {
        process.stderr.write(
          `Cleanup warning: ${cleanupError.stack || cleanupError.message}\n`,
        );
      }
    }
  }
  if (primaryError) throw primaryError;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VM_NAME = process.env.UBUNTU_VM_NAME || "Ubuntu 24.04.3 ARM64";
const GUEST_USER = process.env.UBUNTU_VM_USER || "parallels";
const SHARE_NAME = process.env.UBUNTU_VM_SHARE || "messenger-runtime-prlctl";
const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(PROJECT_ROOT, "release", "linux-runtime-prlctl");
const SHARE_HOST_DIR = path.join(OUT_DIR, "transfer");
const GUEST_ROOT = "/tmp/messenger-runtime-prlctl";
const GUEST_SHARE_DIR = `/media/psf/${SHARE_NAME}`;
const TIMEOUT_SECONDS = Number(process.env.RUNTIME_TIMEOUT_SECONDS || "45");
const SNAP_DISPLAY_MODE = process.env.RUNTIME_SNAP_DISPLAY || "xvfb";
const SNAP_DISPLAY_MODES = new Set(["xvfb", "real-x11"]);

const badPatterns = [
  /FATAL:sandbox/i,
  /Failed to create .*SingletonLock/i,
  /\[SingleInstance\] Lock acquired: false/i,
  /Another instance is already running/i,
  /Messenger-Dev/i,
];

const requiredPatterns = [
  /\[App\] Starting/i,
  /\[SingleInstance\] Lock acquired: true/i,
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    ...options,
  });
}

function prlExec(script, options = {}) {
  return run("prlctl", ["exec", VM_NAME, `bash -lc ${shellQuote(script)}`], options);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function ensureVmRunning() {
  const list = run("prlctl", ["list", "-a"]);
  const line = list
    .split("\n")
    .find((entry) => entry.includes(` ${VM_NAME}`) || entry.endsWith(VM_NAME));

  if (!line) {
    throw new Error(`VM not found: ${VM_NAME}`);
  }

  if (!/\brunning\b/.test(line)) {
    console.log(`[vm] Resuming ${VM_NAME}`);
    run("prlctl", ["resume", VM_NAME], { stdio: "inherit" });
  }
}

function ensureShare() {
  fs.mkdirSync(SHARE_HOST_DIR, { recursive: true });

  const add = spawnSync(
    "prlctl",
    [
      "set",
      VM_NAME,
      "--shf-host-add",
      SHARE_NAME,
      "--path",
      SHARE_HOST_DIR,
    ],
    { encoding: "utf8" },
  );

  if (add.status !== 0 && !/already|exist/i.test(add.stderr + add.stdout)) {
    throw new Error(`Failed to add Parallels shared folder:\n${add.stderr || add.stdout}`);
  }

  prlExec(
    [
      `for i in $(seq 1 20); do`,
      `  [ -d ${shellQuote(GUEST_SHARE_DIR)} ] && exit 0`,
      `  sleep 1`,
      `done`,
      `echo "Shared folder not mounted: ${GUEST_SHARE_DIR}" >&2`,
      `exit 1`,
    ].join("\n"),
  );
}

function guestUserEnv() {
  const uid = prlExec(`id -u ${shellQuote(GUEST_USER)}`).trim();
  const env = prlExec(
    [
      `pid="$(pgrep -u ${shellQuote(GUEST_USER)} -n gnome-shell || true)"`,
      `if [ -n "$pid" ]; then`,
      `  tr '\\0' '\\n' <"/proc/$pid/environ" | grep -E '^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_CURRENT_DESKTOP|XDG_SESSION_TYPE|DBUS_SESSION_BUS_ADDRESS)=' || true`,
      `fi`,
      `xauthority=""`,
      `if [ -n "$pid" ]; then`,
      `  xauthority="$(tr '\\0' '\\n' <"/proc/$pid/environ" | sed -n 's/^XAUTHORITY=//p' | tail -n 1)"`,
      `fi`,
      `if [ -z "$xauthority" ]; then`,
      `  xauthority="$(find /run/user/${uid} -maxdepth 1 -name '.mutter-Xwaylandauth.*' -print -quit 2>/dev/null || true)"`,
      `fi`,
      `if [ -n "$xauthority" ]; then`,
      `  printf 'XAUTHORITY=%s\\n' "$xauthority"`,
      `fi`,
    ].join("\n"),
  );

  const values = Object.fromEntries(
    env
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );

  return {
    uid,
    display: values.DISPLAY || ":0",
    waylandDisplay: values.WAYLAND_DISPLAY || "wayland-0",
    xauthority: values.XAUTHORITY || "",
    desktop: values.XDG_CURRENT_DESKTOP || "ubuntu:GNOME",
    sessionType: values.XDG_SESSION_TYPE || "wayland",
    dbus:
      values.DBUS_SESSION_BUS_ADDRESS ||
      `unix:path=/run/user/${uid}/bus`,
  };
}

function copyArtifactToGuest(localPath) {
  ensureShare();
  const source = path.resolve(localPath);
  const name = path.basename(source);
  const hostTarget = path.join(SHARE_HOST_DIR, name);
  fs.copyFileSync(source, hostTarget);
  return `${GUEST_SHARE_DIR}/${name}`;
}

function launchCommand(command, label, options = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  ensureVmRunning();

  const env = guestUserEnv();
  const displayMode = options.displayMode || SNAP_DISPLAY_MODE;
  if (options.userSystemd && !SNAP_DISPLAY_MODES.has(displayMode)) {
    throw new Error(
      `Unsupported RUNTIME_SNAP_DISPLAY=${displayMode}. Expected one of: ${[
        ...SNAP_DISPLAY_MODES,
      ].join(", ")}`,
    );
  }

  const cleanHome = options.cleanHome !== false;
  const runId = `${label}-${Date.now()}`;
  const logPath = `${GUEST_ROOT}/${runId}.log`;
  const hostLogPath = path.join(OUT_DIR, `${runId}.log`);
  const homePath = `${GUEST_ROOT}/${runId}-home`;
  const runtimePath = `${GUEST_ROOT}/${runId}-runtime`;

  const setup = [
    `set -u`,
    `rm -rf ${shellQuote(homePath)} ${shellQuote(runtimePath)}`,
    `mkdir -p ${shellQuote(homePath)} ${shellQuote(runtimePath)}`,
    `chmod 700 ${shellQuote(runtimePath)}`,
    `chown -R ${shellQuote(GUEST_USER)}:${shellQuote(GUEST_USER)} ${shellQuote(homePath)} ${shellQuote(runtimePath)}`,
  ];

  const baseEnv = [
    `DISPLAY=${shellQuote(env.display)}`,
    `WAYLAND_DISPLAY=${shellQuote(env.waylandDisplay)}`,
    `XDG_CURRENT_DESKTOP=${shellQuote(env.desktop)}`,
    `XDG_SESSION_TYPE=${shellQuote(env.sessionType)}`,
    `DBUS_SESSION_BUS_ADDRESS=${shellQuote(env.dbus)}`,
  ];

  const isolatedEnv = cleanHome
    ? [
        `HOME=${shellQuote(homePath)}`,
        `XDG_CONFIG_HOME=${shellQuote(`${homePath}/.config`)}`,
        `XDG_CACHE_HOME=${shellQuote(`${homePath}/.cache`)}`,
        `XDG_RUNTIME_DIR=${shellQuote(runtimePath)}`,
      ]
    : [`XDG_RUNTIME_DIR=${shellQuote(`/run/user/${env.uid}`)}`];

  const sessionSetup = options.userSystemd
    ? [
        `loginctl enable-linger ${shellQuote(GUEST_USER)}`,
        `systemctl start user@${shellQuote(env.uid)}.service`,
        ...(displayMode === "xvfb"
          ? [
              `if ! command -v xvfb-run >/dev/null 2>&1; then`,
              `  apt-get -o Dpkg::Use-Pty=0 -y install xvfb xauth >/dev/null`,
              `fi`,
            ]
          : []),
      ]
    : [];

  let launchEnv;
  let launchUnset = [];
  let launchTarget = command;
  if (options.userSystemd && displayMode === "xvfb") {
    launchUnset = ["WAYLAND_DISPLAY", "DISPLAY"];
    launchTarget = `xvfb-run -a ${command}`;
    launchEnv = [
      ...isolatedEnv,
      `XDG_CURRENT_DESKTOP=${shellQuote(env.desktop)}`,
      `XDG_SESSION_TYPE=x11`,
      `ELECTRON_OZONE_PLATFORM_HINT=x11`,
    ];
  } else if (options.userSystemd && displayMode === "real-x11") {
    launchUnset = ["WAYLAND_DISPLAY"];
    launchEnv = [
      ...isolatedEnv,
      `DISPLAY=${shellQuote(env.display)}`,
      ...(env.xauthority ? [`XAUTHORITY=${shellQuote(env.xauthority)}`] : []),
      `XDG_CURRENT_DESKTOP=${shellQuote(env.desktop)}`,
      `XDG_SESSION_TYPE=x11`,
      `ELECTRON_OZONE_PLATFORM_HINT=x11`,
      `DBUS_SESSION_BUS_ADDRESS=${shellQuote(env.dbus)}`,
    ];
  } else {
    launchEnv = [...isolatedEnv, ...baseEnv];
  }

  const launchScript = options.userSystemd
    ? [
        `timeout ${TIMEOUT_SECONDS}s env ${launchUnset
          .map((name) => `-u ${name}`)
          .join(" ")} \\`,
        ...launchEnv.map((entry) => `  ${entry} \\`),
        `  ${launchTarget}`,
        `code=$?`,
        `if [ "$code" = 124 ]; then exit 0; fi`,
        `exit "$code"`,
      ].join("\n")
    : [
        `timeout ${TIMEOUT_SECONDS}s runuser -u ${shellQuote(GUEST_USER)} -- env \\`,
        ...launchEnv.map((entry) => `  ${entry} \\`),
        `  ${command}`,
      ].join("\n");

  const runLaunch = options.userSystemd
    ? [
        `runuser -u ${shellQuote(GUEST_USER)} -- env \\`,
        `  XDG_RUNTIME_DIR=${shellQuote(`/run/user/${env.uid}`)} \\`,
        `  DBUS_SESSION_BUS_ADDRESS=${shellQuote(`unix:path=/run/user/${env.uid}/bus`)} \\`,
        `  systemd-run --user --wait --collect --pipe sh -lc ${shellQuote(launchScript)}`,
      ].join("\n")
    : launchScript;

  const script = [
    ...setup,
    ...sessionSetup,
    options.preLaunch || "",
    `set +e`,
    `${runLaunch} >${shellQuote(logPath)} 2>&1`,
    `code=$?`,
    `cat ${shellQuote(logPath)}`,
    `exit "$code"`,
  ].join("\n");

  const result = spawnSync("prlctl", ["exec", VM_NAME, `bash -lc ${shellQuote(script)}`], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  const output = `${result.stdout || ""}${result.stderr || ""}`;
  fs.writeFileSync(hostLogPath, output);

  for (const pattern of badPatterns) {
    if (pattern.test(output)) {
      throw new Error(`Runtime smoke failed (${pattern}). Log: ${hostLogPath}`);
    }
  }

  const missing = requiredPatterns.filter((pattern) => !pattern.test(output));
  if (missing.length > 0) {
    throw new Error(
      `Runtime smoke did not observe required startup markers (${missing
        .map(String)
        .join(", ")}). Log: ${hostLogPath}`,
    );
  }

  if (result.status !== 0 && result.status !== 124) {
    throw new Error(`Launch exited with ${result.status}. Log: ${hostLogPath}`);
  }

  console.log(`[runtime] Passed: ${label}`);
  console.log(`[runtime] Log: ${hostLogPath}`);
}

function appImage(localOrGuestPath) {
  let guestPath = localOrGuestPath;
  if (!localOrGuestPath.startsWith("/media/psf/") && fs.existsSync(localOrGuestPath)) {
    guestPath = copyArtifactToGuest(localOrGuestPath);
  }

  prlExec(`chmod +x ${shellQuote(guestPath)}`);
  launchCommand(
    `MESSENGER_FORKED=1 ${shellQuote(guestPath)}`,
    `appimage-${path.basename(localOrGuestPath).replace(/[^a-zA-Z0-9_.-]/g, "_")}`,
  );
}

function snapInstalled(commandName = "facebook-messenger-desktop") {
  const cleanScript = [
    `runuser -u ${shellQuote(GUEST_USER)} -- sh -lc ${shellQuote(
      [
        `rm -rf "$HOME/snap/${commandName}"`,
        `rm -rf "$HOME/.config/Messenger" "$HOME/.config/Messenger-Beta" "$HOME/.config/Messenger-Dev"`,
        `rm -rf "$HOME/.cache/Messenger" "$HOME/.cache/Messenger-Beta" "$HOME/.cache/Messenger-Dev"`,
      ].join("; "),
    )}`,
  ].join("\n");

  launchCommand(
    `snap run ${shellQuote(commandName)}`,
    `snap-${commandName}`,
    { cleanHome: false, preLaunch: cleanScript, userSystemd: true },
  );
}

function status() {
  ensureVmRunning();
  console.log(prlExec(`cat /etc/os-release | sed -n '1,6p'; uname -m; loginctl list-users || true; loginctl list-sessions || true; snap version || true; command -v xvfb-run || true; ls -la /media/psf || true`));
}

function usage() {
  console.log(`Usage:
  node scripts/test-linux-runtime-prlctl.js status
  node scripts/test-linux-runtime-prlctl.js appimage <local-or-guest-AppImage>
  node scripts/test-linux-runtime-prlctl.js snap-installed [command-name]

Environment:
  UBUNTU_VM_NAME=${VM_NAME}
  UBUNTU_VM_USER=${GUEST_USER}
  UBUNTU_VM_SHARE=${SHARE_NAME}
  RUNTIME_TIMEOUT_SECONDS=${TIMEOUT_SECONDS}
  RUNTIME_SNAP_DISPLAY=${SNAP_DISPLAY_MODE} (xvfb|real-x11)`);
}

function main() {
  const [command, arg] = process.argv.slice(2);

  if (command === "status") {
    status();
    return;
  }

  if (command === "appimage" && arg) {
    appImage(arg);
    return;
  }

  if (command === "snap-installed") {
    snapInstalled(arg);
    return;
  }

  usage();
  process.exit(command ? 2 : 0);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { canonicalize } from "@tufjs/canonical-json";
import {
  createTufVerifiedUpdateFeed,
  initializeTrustedRoot,
  validateTufRepositoryUrl,
  validateTufTargetName,
} from "../src/main/tuf-update-feed";

type Fixture = {
  metadata: Record<string, Buffer>;
  targetBytes: Buffer;
  targetName: string;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signedMetadata(
  signed: Record<string, unknown>,
  keyID: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): Record<string, unknown> {
  return {
    signatures: [
      {
        keyid: keyID,
        sig: sign(
          null,
          Buffer.from(canonicalize(signed)),
          privateKey,
        ).toString("hex"),
      },
    ],
    signed,
  };
}

function tufFixture(
  targetName = "latest.yml",
  expires = "2035-01-01T00:00:00Z",
): Fixture {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const key = {
    keytype: "ed25519",
    scheme: "ed25519",
    keyval: { public: publicDer.subarray(-32).toString("hex") },
  };
  const keyID = sha256(Buffer.from(canonicalize(key)));
  const role = { keyids: [keyID], threshold: 1 };
  const targetBytes = Buffer.from("version: 1.0.1\nfiles: []\n");
  const targets = signedMetadata(
    {
      _type: "targets",
      spec_version: "1.0.31",
      version: 1,
      expires,
      targets: {
        [targetName]: {
          length: targetBytes.length,
          hashes: { sha256: sha256(targetBytes) },
        },
      },
    },
    keyID,
    privateKey,
  );
  const targetsBytes = Buffer.from(JSON.stringify(targets));
  const snapshot = signedMetadata(
    {
      _type: "snapshot",
      spec_version: "1.0.31",
      version: 1,
      expires,
      meta: {
        "targets.json": {
          version: 1,
          length: targetsBytes.length,
          hashes: { sha256: sha256(targetsBytes) },
        },
      },
    },
    keyID,
    privateKey,
  );
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  const timestamp = signedMetadata(
    {
      _type: "timestamp",
      spec_version: "1.0.31",
      version: 1,
      expires,
      meta: {
        "snapshot.json": {
          version: 1,
          length: snapshotBytes.length,
          hashes: { sha256: sha256(snapshotBytes) },
        },
      },
    },
    keyID,
    privateKey,
  );
  const root = signedMetadata(
    {
      _type: "root",
      spec_version: "1.0.31",
      version: 1,
      expires,
      consistent_snapshot: false,
      keys: { [keyID]: key },
      roles: {
        root: role,
        snapshot: role,
        targets: role,
        timestamp: role,
      },
    },
    keyID,
    privateKey,
  );
  return {
    metadata: {
      "root.json": Buffer.from(JSON.stringify(root)),
      "snapshot.json": snapshotBytes,
      "targets.json": targetsBytes,
      "timestamp.json": Buffer.from(JSON.stringify(timestamp)),
    },
    targetBytes,
    targetName,
  };
}

async function fixtureServer(
  fixture: Fixture,
  redirectMetadata = false,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = http.createServer((request, response) => {
    if (redirectMetadata && request.url?.includes("timestamp.json")) {
      response.writeHead(302, { Location: "/redirected" }).end();
      return;
    }
    const match = request.url?.match(/^\/(metadata|targets)\/([^/?]+)$/);
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    if (match[1] === "metadata" && match[2] === "2.root.json") {
      response.writeHead(404).end();
      return;
    }
    const bytes =
      match[1] === "metadata"
        ? fixture.metadata[match[2]]
        : match[2] === fixture.targetName
          ? fixture.targetBytes
          : null;
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Length": bytes.length });
    response.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    url: `http://127.0.0.1:${address.port}`,
  };
}

test("repository and target validation fail closed", () => {
  assert.equal(
    validateTufRepositoryUrl("https://updates.example/messenger/"),
    "https://updates.example/messenger",
  );
  assert.throws(
    () => validateTufRepositoryUrl("http://updates.example/messenger"),
    /must use HTTPS/,
  );
  assert.throws(
    () => validateTufRepositoryUrl("https://user@updates.example/messenger"),
    /cannot contain credentials/,
  );
  assert.equal(validateTufTargetName("latest.yml"), "latest.yml");
  assert.throws(() => validateTufTargetName("../latest.yml"), /Unsafe/);
  assert.throws(() => validateTufTargetName("nested/latest.yml"), /Unsafe/);
});

test("embedded root initializes once and preserves advanced trust", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "messenger-tuf-bootstrap-"),
  );
  try {
    const embeddedRootPath = path.join(temporary, "embedded-root.json");
    const metadataDir = path.join(temporary, "metadata");
    fs.writeFileSync(embeddedRootPath, "root version one");
    const first = initializeTrustedRoot({
      embeddedRootPath,
      metadataDir,
    });
    fs.writeFileSync(first.trustedRootPath, "advanced root version two");
    fs.writeFileSync(embeddedRootPath, "replacement app root");
    const second = initializeTrustedRoot({
      embeddedRootPath,
      metadataDir,
    });
    assert.equal(second.initialized, false);
    assert.equal(
      fs.readFileSync(second.trustedRootPath, "utf8"),
      "advanced root version two",
    );
    fs.rmSync(second.trustedRootPath);
    fs.symlinkSync(embeddedRootPath, second.trustedRootPath);
    assert.throws(
      () =>
        initializeTrustedRoot({
          embeddedRootPath,
          metadataDir,
        }),
      /not a regular file/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("local feed serves only metadata authenticated by TUF", async () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "messenger-tuf-feed-"),
  );
  const fixture = tufFixture();
  const repository = await fixtureServer(fixture);
  let feed: Awaited<ReturnType<typeof createTufVerifiedUpdateFeed>> | null =
    null;
  try {
    const embeddedRootPath = path.join(temporary, "root.json");
    fs.writeFileSync(embeddedRootPath, fixture.metadata["root.json"]);
    feed = await createTufVerifiedUpdateFeed({
      embeddedRootPath,
      repositoryUrl: repository.url,
      targetName: fixture.targetName,
      trustDir: path.join(temporary, "trust"),
      allowLoopbackHttp: true,
    });
    const response = await fetch(`${feed.feedUrl}/${fixture.targetName}`);
    assert.equal(response.status, 200);
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      fixture.targetBytes,
    );
    assert.equal(
      (await fetch(`${feed.feedUrl}/unexpected.yml`)).status,
      404,
    );
    await feed.refresh();
    await feed.close();
    await feed.close();
    feed = null;
  } finally {
    if (feed) await feed.close();
    await repository.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("tampered targets and metadata redirects are rejected", async () => {
  for (const mode of ["tamper", "redirect"] as const) {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), `messenger-tuf-${mode}-`),
    );
    const fixture = tufFixture();
    if (mode === "tamper") {
      fixture.targetBytes = Buffer.from("untrusted metadata");
    }
    const repository = await fixtureServer(fixture, mode === "redirect");
    try {
      const embeddedRootPath = path.join(temporary, "root.json");
      fs.writeFileSync(embeddedRootPath, fixture.metadata["root.json"]);
      await assert.rejects(
        createTufVerifiedUpdateFeed({
          embeddedRootPath,
          repositoryUrl: repository.url,
          targetName: fixture.targetName,
          trustDir: path.join(temporary, "trust"),
          allowLoopbackHttp: true,
        }),
        mode === "tamper" ? /hash|length/i : /redirect/i,
      );
    } finally {
      await repository.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
});

test("expired, incorrectly signed, and missing metadata fail closed", async () => {
  for (const mode of ["expired", "wrong-signature", "missing"] as const) {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), `messenger-tuf-${mode}-`),
    );
    const fixture =
      mode === "expired"
        ? tufFixture("latest.yml", "2020-01-01T00:00:00Z")
        : mode === "missing"
          ? tufFixture("other.yml")
          : tufFixture();
    if (mode === "wrong-signature") {
      const timestamp = JSON.parse(
        fixture.metadata["timestamp.json"].toString("utf8"),
      );
      timestamp.signatures[0].sig = "00".repeat(64);
      fixture.metadata["timestamp.json"] = Buffer.from(
        JSON.stringify(timestamp),
      );
    }
    const repository = await fixtureServer(fixture);
    try {
      const embeddedRootPath = path.join(temporary, "root.json");
      fs.writeFileSync(embeddedRootPath, fixture.metadata["root.json"]);
      await assert.rejects(
        createTufVerifiedUpdateFeed({
          embeddedRootPath,
          repositoryUrl: repository.url,
          targetName: "latest.yml",
          trustDir: path.join(temporary, "trust"),
          allowLoopbackHttp: true,
        }),
        mode === "expired"
          ? /expired/i
          : mode === "missing"
            ? /no latest\.yml target/i
          : /sign(?:ed|ature)/i,
      );
    } finally {
      await repository.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
});

/**
 * Pins the secrets-manager v1 wire contract.
 *
 * Traceability: every assertion names the rule (R#) or backwards-compatibility
 * invariant (BC#) from `.work/features/secrets-manager/20261025-SPEC.md`.
 *
 * Gate: this file must pass against the deployed commit (269b9c6) unchanged.
 *   SM_SERVER_ENTRY=<baseline>/secrets-manager/server.mjs node --test secrets-manager/test/
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  ACB,
  ACB_PREFIX,
  ADMIN,
  GEN,
  GEN_PREFIX,
  REGION,
  call,
  getJson,
  newDataDir,
  rawPost,
  signV4,
  sortKeys,
  startService,
} from "./helpers.mjs";

const ADMIN_ONLY_OPERATIONS = [
  "CreateClientCredential",
  "DeleteClientCredential",
  "GetClientCredential",
  "ListClientCredentials",
];

const OPERATIONS = [
  "BatchGetSecretValue",
  "CreateClientCredential",
  "CreateSecret",
  "DeleteClientCredential",
  "DeleteSecret",
  "DescribeSecret",
  "GetClientCredential",
  "GetRandomPassword",
  "ListClientCredentials",
  "ListSecretVersionIds",
  "ListSecrets",
  "PutSecretValue",
  "RestoreSecret",
  "TagResource",
  "UntagResource",
  "UpdateSecret",
  "GetSecretValue",
].sort();

let svc;

before(async () => {
  svc = await startService({ tag: "contract" });
});

after(async () => {
  if (svc) {
    await svc.stop();
  }
});

// ---------------------------------------------------------------------------

describe("R1/R2/R3 - surface", () => {
  it("R1/BC5: GET /healthz keeps its exact shape and status", async () => {
    const { status, data, headers } = await getJson(svc.baseUrl, "/healthz");
    assert.equal(status, 200);
    assert.deepEqual(sortKeys(data), [
      "authRequired",
      "service",
      "status",
      "time",
      "version",
    ]);
    assert.equal(data.status, "ok");
    assert.equal(data.service, "secrets-manager");
    assert.equal(data.version, "1.1.0");
    assert.equal(data.authRequired, true);
    assert.match(data.time, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(headers.get("content-type") || "", /^application\/json/);
    assert.ok(headers.get("x-amzn-requestid"));
  });

  it("R2: GET /readyz reports readiness with the documented fields", async () => {
    const { status, data } = await getJson(svc.baseUrl, "/readyz");
    assert.equal(status, 200);
    assert.equal(data.status, "ready");
    assert.equal(data.ok, true);
    if (svc.mode === "admin-listener") {
      // Hardened build: the public probe answers liveness only (BC6 payload
      // reduction); the operational detail stays on the loopback listener.
      assert.deepEqual(sortKeys(data), ["ok", "status", "version"]);
      const admin = await getJson(svc.adminUrl, "/readyz");
      assert.equal(admin.status, 200);
      for (const key of ["secrets", "deletedSecrets", "managedClients", "dataDir", "masterKeySource"]) {
        assert.ok(key in admin.data, `${key} on the admin listener`);
      }
      assert.equal(admin.data.writable, true);
    } else {
      for (const key of ["secrets", "deletedSecrets", "managedClients", "writable", "dataDir", "masterKeySource"]) {
        assert.ok(key in data, `${key} present`);
      }
      assert.equal(data.writable, true);
    }
  });

  it("R3/BC3/BC9: GET / advertises the operation inventory, sorted", async () => {
    const { status, data } = await getJson(svc.baseUrl, "/");
    assert.equal(status, 200);
    assert.equal(data.protocol, "aws-json-1.1");
    assert.equal(data.authRequired, true);
    assert.equal(data.service, "secrets-manager");
    assert.deepEqual(data.health, ["/healthz", "/readyz"]);
    const expected =
      svc.mode === "public-admin"
        ? OPERATIONS
        : OPERATIONS.filter((op) => !ADMIN_ONLY_OPERATIONS.includes(op));
    assert.deepEqual([...data.operations], expected);
    assert.deepEqual([...data.operations], [...data.operations].sort());
  });

  it("R3: GET /info is an alias of GET /", async () => {
    const info = await getJson(svc.baseUrl, "/info");
    assert.equal(info.status, 200);
    assert.deepEqual([...info.data.operations], [...(await getJson(svc.baseUrl, "/")).data.operations]);
  });

  it("R4: an unknown path is InvalidRequestException", async () => {
    const { status, data } = await getJson(svc.baseUrl, "/nope");
    assert.equal(status, 400);
    assert.equal(data.__type, "InvalidRequestException");
  });

  it("R4: a non-POST method on / is rejected", async () => {
    const response = await fetch(new URL(svc.baseUrl), { method: "PUT" });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.equal(data.__type, "InvalidRequestException");
    assert.match(String(data.message), /Only POST requests are supported/);
  });
});

// ---------------------------------------------------------------------------

describe("R4/R6/R7/R8 - request validation and error taxonomy (BC4)", () => {
  it("R6: a missing X-Amz-Target is UnknownOperationException", async () => {
    const url = new URL(svc.baseUrl);
    const headers = signV4({
      method: "POST",
      url,
      accessKeyId: ADMIN.accessKeyId,
      secretAccessKey: ADMIN.secretAccessKey,
      body: "{}",
      headers: { "content-type": "application/x-amz-json-1.1" },
    });
    const { host, ...sendable } = headers;
    const { status, data } = await rawPost(svc.baseUrl, sendable, "{}");
    assert.equal(status, 400);
    assert.equal(data.__type, "UnknownOperationException");
  });

  it("R6: a foreign service prefix is UnknownOperationException", async () => {
    const { status, data } = await call(svc.baseUrl, ADMIN, "ListSecrets", {}, {
      target: "s3.ListSecrets",
    });
    assert.equal(status, 400);
    assert.equal(data.__type, "UnknownOperationException");
  });

  it("R6: an unknown operation is UnknownOperationException", async () => {
    const { status, data } = await call(svc.baseUrl, ADMIN, "NoSuchOperation");
    assert.equal(status, 400);
    assert.equal(data.__type, "UnknownOperationException");
  });

  it("R7: a non-JSON body is SerializationException", async () => {
    const { status, data } = await call(svc.baseUrl, ADMIN, "ListSecrets", {}, {
      rawBody: "not-json",
    });
    assert.equal(status, 400);
    assert.equal(data.__type, "SerializationException");
  });

  it("R8: a JSON array body is InvalidParameterException", async () => {
    const { status, data } = await call(svc.baseUrl, ADMIN, "ListSecrets", {}, {
      rawBody: "[]",
    });
    assert.equal(status, 400);
    assert.equal(data.__type, "InvalidParameterException");
  });

  it("BC4: every error uses the {__type, message} envelope", async () => {
    const { data } = await call(svc.baseUrl, ADMIN, "NoSuchOperation");
    assert.deepEqual(sortKeys(data).filter((k) => k === "__type" || k === "message"), [
      "__type",
      "message",
    ]);
    assert.equal(typeof data.message, "string");
  });
});

// ---------------------------------------------------------------------------

describe("R11-R17 - SigV4 authentication", () => {
  it("R11/R12: a valid signature is accepted", async () => {
    const { status, data } = await call(svc.baseUrl, ADMIN, "ListSecrets");
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.SecretList));
  });

  it("R17: a tampered signature is InvalidSignatureException 403", async () => {
    const { status, data } = await call(svc.baseUrl, ADMIN, "ListSecrets", {}, {
      mutate: (headers) => {
        headers.authorization = headers.authorization.replace(/Signature=([0-9a-f])/, (m, c) =>
          `Signature=${c === "0" ? "1" : "0"}`,
        );
      },
    });
    assert.equal(status, 403);
    assert.equal(data.__type, "InvalidSignatureException");
  });

  it("R17: no Authorization header is MissingAuthenticationTokenException", async () => {
    const { status, data } = await call(svc.baseUrl, ADMIN, "ListSecrets", {}, {
      mutate: (headers) => {
        delete headers.authorization;
      },
    });
    assert.equal(status, 400);
    assert.equal(data.__type, "MissingAuthenticationTokenException");
  });

  it("R17: an unknown access key is UnrecognizedClientException", async () => {
    const { status, data } = await call(
      svc.baseUrl,
      { accessKeyId: "AKIANOSUCHKEY0001", secretAccessKey: "nope" },
      "ListSecrets",
    );
    assert.equal(status, 400);
    assert.equal(data.__type, "UnrecognizedClientException");
  });

  it("R13: a request outside the clock-skew window is rejected", async () => {
    const { status, data } = await call(svc.baseUrl, ADMIN, "ListSecrets", {}, {
      now: new Date(Date.now() - 25 * 60 * 1000),
    });
    assert.equal(status, 400);
    assert.equal(data.__type, "RequestExpired");
  });

  it("R14: a body that does not match x-amz-content-sha256 is rejected", async () => {
    const url = new URL(svc.baseUrl);
    const signedBody = "{}";
    const sentBody = JSON.stringify({ MaxResults: 1 });
    const headers = signV4({
      method: "POST",
      url,
      accessKeyId: ADMIN.accessKeyId,
      secretAccessKey: ADMIN.secretAccessKey,
      body: signedBody,
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "secretsmanager.ListSecrets",
      },
    });
    const { host, ...sendable } = headers;
    const { status, data } = await rawPost(svc.baseUrl, sendable, sentBody);
    assert.equal(status, 400);
    assert.equal(data.__type, "XAmzContentSHA256Mismatch");
  });

  it("R16: a signature for the wrong region is rejected", async () => {
    const url = new URL(svc.baseUrl);
    const headers = signV4({
      method: "POST",
      url,
      region: "eu-west-1",
      accessKeyId: ADMIN.accessKeyId,
      secretAccessKey: ADMIN.secretAccessKey,
      body: "{}",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "secretsmanager.ListSecrets",
      },
    });
    const { host, ...sendable } = headers;
    const { status, data } = await rawPost(svc.baseUrl, sendable, "{}");
    assert.equal(status, 403);
    assert.equal(data.__type, "InvalidSignatureException");
  });
});

// ---------------------------------------------------------------------------

describe("R19-R22 - authorization and prefix scoping", () => {
  const SECRET_NAME = `${GEN_PREFIX}app-config`;
  const ACB_SECRET = `${ACB_PREFIX}token-a`;

  it("R19/BC1: the generator client reads inside its own prefix", async () => {
    const created = await call(svc.baseUrl, ADMIN, "CreateSecret", {
      Name: SECRET_NAME,
      SecretString: '{"limits":{"requestsPerMinute":60}}',
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));

    const got = await call(svc.baseUrl, GEN, "GetSecretValue", { SecretId: SECRET_NAME });
    assert.equal(got.status, 200);
    assert.equal(got.data.SecretString, '{"limits":{"requestsPerMinute":60}}');
    assert.equal(got.data.Name, SECRET_NAME);
  });

  it("R19/BC2: the ACB client works inside client/acb/", async () => {
    const created = await call(svc.baseUrl, ADMIN, "CreateSecret", {
      Name: ACB_SECRET,
      SecretString: "acb-token",
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));

    const got = await call(svc.baseUrl, ACB, "GetSecretValue", { SecretId: ACB_SECRET });
    assert.equal(got.status, 200);
    assert.equal(got.data.SecretString, "acb-token");
  });

  it("R19: a client cannot read outside its prefix", async () => {
    const { status, data } = await call(svc.baseUrl, GEN, "GetSecretValue", {
      SecretId: ACB_SECRET,
    });
    assert.equal(status, 400);
    assert.equal(data.__type, "AccessDeniedException");
  });

  it("R19: prefix matching respects segment boundaries (client/acb2/ is not client/acb/)", async () => {
    await call(svc.baseUrl, ADMIN, "CreateSecret", {
      Name: "client/acb2/other",
      SecretString: "nope",
    });
    const { status, data } = await call(svc.baseUrl, ACB, "GetSecretValue", {
      SecretId: "client/acb2/other",
    });
    assert.equal(status, 400);
    assert.equal(data.__type, "AccessDeniedException");
  });

  it("R20: a non-admin cannot list client credentials", async () => {
    const { status, data } = await call(svc.baseUrl, GEN, "ListClientCredentials");
    assert.equal(status, 400);
    assert.equal(data.__type, "AccessDeniedException");
    assert.match(String(data.message), /administrator|admin listener/i);
  });

  it("R20/R33: the admin can list client credentials", async () => {
    const target = svc.mode === "admin-listener" ? svc.adminUrl : svc.baseUrl;
    const { status, data } = await call(target, ADMIN, "ListClientCredentials");
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.ClientCredentialList), JSON.stringify(data));
    const names = data.ClientCredentialList.map((client) => client.Name);
    assert.deepEqual(names, [...names].sort(), "listing is sorted by name");
    const generator = data.ClientCredentialList.find((client) => client.Name === "password-generator");
    assert.ok(generator, "generator client is listed");
    assert.equal(generator.Source, "static");
    assert.deepEqual(generator.AllowedPrefixes, [GEN_PREFIX]);
    assert.equal(
      "SecretAccessKey" in generator,
      false,
      "the list projection must never include a secret",
    );
  });

  it("R22: GetRandomPassword needs no secret access", async () => {
    const { status, data } = await call(svc.baseUrl, GEN, "GetRandomPassword", {
      PasswordLength: 24,
    });
    assert.equal(status, 200);
    assert.equal(typeof data.RandomPassword, "string");
    assert.equal(data.RandomPassword.length, 24);
  });

  it("R21: ListSecrets is filtered by prefix for non-admins", async () => {
    const { status, data } = await call(svc.baseUrl, GEN, "ListSecrets");
    assert.equal(status, 200);
    for (const entry of data.SecretList) {
      assert.ok(
        String(entry.Name).startsWith(GEN_PREFIX),
        `${entry.Name} leaked into the generator client's listing`,
      );
    }
  });
});

describe("BC9 - administrative surface", () => {
  const ADMIN_OPS = ADMIN_ONLY_OPERATIONS;

  it("BC9: the public listener never exposes credential management when hardened", async (t) => {
    if (svc.mode !== "admin-listener") {
      t.skip("baseline build exposes admin operations publicly — BC9 change not applied");
      return;
    }
    for (const operation of ADMIN_OPS) {
      const { status, data } = await call(svc.baseUrl, ADMIN, operation);
      assert.equal(status, 400, `${operation} must be denied on the public listener`);
      assert.equal(data.__type, "AccessDeniedException", `${operation} leaked`);
      assert.match(String(data.message), /admin listener/i);
    }
  });

  it("BC9: the loopback admin listener serves credential management", async (t) => {
    if (svc.mode !== "admin-listener") {
      t.skip("baseline build has no admin listener — BC9 change not applied");
      return;
    }
    const listed = await call(svc.adminUrl, ADMIN, "ListClientCredentials");
    assert.equal(listed.status, 200, JSON.stringify(listed.data));
    assert.ok(Array.isArray(listed.data.ClientCredentialList));

    const ops = await getJson(svc.adminUrl, "/");
    assert.deepEqual([...ops.data.operations], OPERATIONS, "admin listener advertises all 17");
  });

  it("BC9: data-plane operations keep working on the public listener", async () => {
    const listed = await call(svc.baseUrl, GEN, "ListSecrets");
    assert.equal(listed.status, 200, "a normal client is unaffected by the admin split");
    const health = await getJson(svc.baseUrl, "/healthz");
    assert.equal(health.status, 200);
  });
});

// ---------------------------------------------------------------------------

describe("R35-R38 - client credential lifecycle (two-phase rotation)", () => {
  const adminTarget = () => (svc.mode === "admin-listener" ? svc.adminUrl : svc.baseUrl);

  it("R35: creating a managed client returns its secret and metadata", async () => {
    const { status, data } = await call(adminTarget(), ADMIN, "CreateClientCredential", {
      Name: "rotation-a",
      Description: "two-phase rotation test",
      AllowedPrefixes: ["client/rot/"],
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.Name, "rotation-a");
    assert.equal(typeof data.SecretAccessKey, "string");
    assert.ok(data.SecretAccessKey.length >= 16, "secret is returned once, on creation");
    assert.deepEqual(data.AllowedPrefixes, ["client/rot/"]);
    assert.equal(data.Source, "managed");
  });

  it("R36: a managed credential authenticates and is prefix-scoped", async () => {
    const { data } = await call(adminTarget(), ADMIN, "GetClientCredential", { Name: "rotation-a" });
    const managed = { accessKeyId: data.AccessKeyId, secretAccessKey: data.SecretAccessKey };

    const listed = await call(svc.baseUrl, managed, "ListSecrets");
    assert.equal(listed.status, 200, "managed credential authenticates");

    const denied = await call(svc.baseUrl, managed, "GetSecretValue", {
      SecretId: `${GEN_PREFIX}app-config`,
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.data.__type, "AccessDeniedException", "outside its prefix");
  });

  it("R37: two credentials can coexist, so rotation needs no outage", async () => {
    const created = await call(adminTarget(), ADMIN, "CreateClientCredential", {
      Name: "rotation-b",
      AllowedPrefixes: ["client/rot/"],
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));

    const a = await call(adminTarget(), ADMIN, "GetClientCredential", { Name: "rotation-a" });
    const b = await call(adminTarget(), ADMIN, "GetClientCredential", { Name: "rotation-b" });
    const credA = { accessKeyId: a.data.AccessKeyId, secretAccessKey: a.data.SecretAccessKey };
    const credB = { accessKeyId: b.data.AccessKeyId, secretAccessKey: b.data.SecretAccessKey };

    // Both are valid at once — the old one still works after the new one exists.
    assert.equal((await call(svc.baseUrl, credA, "ListSecrets")).status, 200);
    assert.equal((await call(svc.baseUrl, credB, "ListSecrets")).status, 200);

    // Revoking the predecessor must not disturb the successor.
    const deleted = await call(adminTarget(), ADMIN, "DeleteClientCredential", { Name: "rotation-a" });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));

    const oldKey = await call(svc.baseUrl, credA, "ListSecrets");
    assert.equal(oldKey.status, 400);
    assert.equal(oldKey.data.__type, "UnrecognizedClientException", "revoked key is rejected");

    const newKey = await call(svc.baseUrl, credB, "ListSecrets");
    assert.equal(newKey.status, 200, "successor unaffected by the revocation");
  });

  it("R38: static credentials cannot be deleted through the API", async () => {
    const { status, data } = await call(adminTarget(), ADMIN, "DeleteClientCredential", {
      Name: "password-generator",
    });
    assert.equal(status, 400);
    assert.equal(data.__type, "InvalidRequestException");
    assert.match(String(data.message), /SM_CLIENTS_JSON|read-only/i);
  });
});

// ---------------------------------------------------------------------------

describe("R23-R31 - store semantics (BC8, BC10)", () => {
  const NAME = `${GEN_PREFIX}integrity`;

  it("R23/R24: values round-trip exactly, including unicode", async () => {
    const value = 'sha256:deadbeef\nemoji: 🔐 ümlaut';
    const created = await call(svc.baseUrl, ADMIN, "CreateSecret", {
      Name: NAME,
      SecretString: value,
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));

    const got = await call(svc.baseUrl, ADMIN, "GetSecretValue", { SecretId: NAME });
    assert.equal(got.data.SecretString, value);
    assert.ok(got.data.VersionId);
    assert.deepEqual(got.data.VersionStages, ["AWSCURRENT"]);
  });

  it("R26/R27/BC10: rotation keeps one AWSCURRENT and demotes the previous to AWSPREVIOUS", async () => {
    const first = await call(svc.baseUrl, ADMIN, "GetSecretValue", { SecretId: NAME });
    const put = await call(svc.baseUrl, ADMIN, "PutSecretValue", {
      SecretId: NAME,
      SecretString: "rotated-value",
    });
    assert.equal(put.status, 200, JSON.stringify(put.data));

    const versions = await call(svc.baseUrl, ADMIN, "ListSecretVersionIds", { SecretId: NAME });
    assert.equal(versions.status, 200);
    const current = versions.data.Versions.filter((v) => v.VersionStages.includes("AWSCURRENT"));
    const previous = versions.data.Versions.filter((v) => v.VersionStages.includes("AWSPREVIOUS"));
    assert.equal(current.length, 1, "exactly one AWSCURRENT");
    assert.equal(previous.length, 1, "exactly one AWSPREVIOUS");
    assert.notEqual(current[0].VersionId, first.data.VersionId);
    assert.equal(previous[0].VersionId, first.data.VersionId, "previous current becomes AWSPREVIOUS");
    assert.match(current[0].VersionId, /^[0-9a-f-]{36}$/i, "version ids are UUIDs");

    const latest = await call(svc.baseUrl, ADMIN, "GetSecretValue", { SecretId: NAME });
    assert.equal(latest.data.SecretString, "rotated-value");
  });

  it("R28/BC10: soft delete hides the secret but keeps it restorable", async () => {
    const fullReadyz = async () =>
      getJson(svc.mode === "admin-listener" ? svc.adminUrl : svc.baseUrl, "/readyz");
    const before = await fullReadyz();
    const deleted = await call(svc.baseUrl, ADMIN, "DeleteSecret", { SecretId: NAME });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));

    const afterDelete = await fullReadyz();
    assert.equal(
      afterDelete.data.deletedSecrets,
      before.data.deletedSecrets + 1,
      "deletedSecrets increments",
    );

    const gone = await call(svc.baseUrl, ADMIN, "GetSecretValue", { SecretId: NAME });
    assert.equal(gone.status, 400);
    assert.equal(
      gone.data.__type,
      "InvalidRequestException",
      "a secret in its recovery window is InvalidRequestException, matching AWS",
    );
    assert.match(String(gone.data.message), /marked for deletion/);

    const list = await call(svc.baseUrl, ADMIN, "ListSecrets");
    assert.ok(
      !list.data.SecretList.some((s) => s.Name === NAME),
      "soft-deleted secret must not appear in ListSecrets",
    );

    const restored = await call(svc.baseUrl, ADMIN, "RestoreSecret", { SecretId: NAME });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));

    const back = await call(svc.baseUrl, ADMIN, "GetSecretValue", { SecretId: NAME });
    assert.equal(back.status, 200);
    assert.equal(back.data.SecretString, "rotated-value");
  });

  it("R28/BC10: restore brings back the last current value", async () => {
    const back = await call(svc.baseUrl, ADMIN, "GetSecretValue", { SecretId: NAME });
    assert.equal(back.status, 200);
    assert.equal(back.data.SecretString, "rotated-value");
  });
});

// ---------------------------------------------------------------------------

describe("R24/R29/BC8 - persistence across a restart", () => {
  it("a fresh process on the same data dir and master key reads the same ciphertext", async () => {
    const dataDir = newDataDir("restart");
    const first = await startService({ dataDir, tag: "restart-a" });
    try {
      const created = await call(first.baseUrl, ADMIN, "CreateSecret", {
        Name: `${GEN_PREFIX}restart-probe`,
        SecretString: "survives-restart",
      });
      assert.equal(created.status, 200, JSON.stringify(created.data));
    } finally {
      await first.stop();
    }

    const second = await startService({ dataDir, tag: "restart-b" });
    try {
      const got = await call(second.baseUrl, ADMIN, "GetSecretValue", {
        SecretId: `${GEN_PREFIX}restart-probe`,
      });
      assert.equal(got.status, 200, JSON.stringify(got.data));
      assert.equal(got.data.SecretString, "survives-restart");
    } finally {
      await second.stop();
    }
  });
});

// ---------------------------------------------------------------------------

describe("R5 - body limits", () => {
  it("R5/D1: an oversized body is refused, never truncated", async () => {
    // Pins observed behaviour at 269b9c6. The documented intent is HTTP 413
    // InvalidParameterException; today the socket is destroyed first, so the
    // client sees a transport failure. Defect D1 in the SPEC tracks the fix.
    const oversized = "x".repeat(1024 * 1024 + 1024);
    let outcome;
    try {
      outcome = await call(svc.baseUrl, ADMIN, "CreateSecret", {}, {
        rawBody: JSON.stringify({ Name: `${GEN_PREFIX}big`, SecretString: oversized }),
      });
    } catch (error) {
      outcome = { transport: error.cause?.code || error.code || error.message };
    }

    if (outcome.transport) {
      // Baseline only: D1 (socket destroyed before the 413 could be written).
      assert.equal(
        svc.mode,
        "public-admin",
        `the hardened build must return HTTP 413, not ${outcome.transport}`,
      );
      assert.match(
        String(outcome.transport),
        /ECONNRESET|UND_ERR|fetch failed/i,
        `unexpected transport error: ${outcome.transport}`,
      );
    } else {
      assert.equal(outcome.status, 413, "intended behaviour: HTTP 413");
      assert.equal(outcome.data.__type, "InvalidParameterException");
    }

    // Whatever the transport did, the oversized secret must not exist.
    const list = await call(svc.baseUrl, ADMIN, "ListSecrets");
    assert.ok(
      !list.data.SecretList.some((s) => s.Name === `${GEN_PREFIX}big`),
      "an oversized body must never be partially applied",
    );
  });
});

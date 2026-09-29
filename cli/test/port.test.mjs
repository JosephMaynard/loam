// Tests for the `loam` launcher's port selection (cli/bin/port.js). Run with `node --test` (root
// `pnpm test`). Each test holds real sockets, so it only uses ports the OS hands out as free.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, describe, it } from "node:test";

import { findFreePort, isPortFree, probeHosts } from "../bin/port.js";

const held = [];

/** Listen on `host:port` (port 0 = any) and keep it open until the suite ends; resolves the port. */
function hold(host, port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host, port }, () => {
      held.push(server);
      resolve(server.address().port);
    });
  });
}

after(async () => {
  await Promise.all(held.map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("probeHosts", () => {
  it("adds loopback for a wildcard host", () => {
    assert.deepEqual(probeHosts("0.0.0.0"), ["0.0.0.0", "127.0.0.1", "::1"]);
    assert.deepEqual(probeHosts("::"), ["::", "127.0.0.1", "::1"]);
  });

  it("probes only a specific host", () => {
    assert.deepEqual(probeHosts("192.168.1.5"), ["192.168.1.5"]);
  });
});

describe("isPortFree", () => {
  it("reports a port another server holds on the wildcard address", async () => {
    const port = await hold("0.0.0.0");
    assert.equal(await isPortFree(port, "0.0.0.0"), false);
  });

  it("reports a port another server holds only on loopback", async () => {
    const port = await hold("127.0.0.1");
    assert.equal(await isPortFree(port, "0.0.0.0"), false);
  });

  it("reports a released port as free", async () => {
    const port = await hold("0.0.0.0");
    await new Promise((resolve) => held.pop().close(resolve));
    assert.equal(await isPortFree(port, "0.0.0.0"), true);
  });
});

describe("findFreePort", () => {
  it("steps past a taken port", async () => {
    const taken = await hold("0.0.0.0");
    const port = await findFreePort(taken, "0.0.0.0", 20);
    assert.ok(port !== undefined && port > taken && port < taken + 20);
    assert.equal(await isPortFree(port, "0.0.0.0"), true);
  });

  it("returns undefined when every port in the range is taken", async () => {
    const taken = await hold("0.0.0.0");
    assert.equal(await findFreePort(taken, "0.0.0.0", 1), undefined);
  });

  it("never looks past 65535", async () => {
    const port = await findFreePort(65535, "0.0.0.0", 20);
    assert.ok(port === undefined || port === 65535);
  });
});

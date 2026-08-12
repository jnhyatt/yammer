/**
 * The readiness probe's timeout.
 *
 * One test, for one silent failure. A rootless published port is bound by
 * Podman's port forwarder before anything inside the container is listening, so
 * during a workspace's first seconds the connection is accepted and then
 * nothing comes back. `fetch` has no default timeout, so an unbounded probe
 * waits there indefinitely — and a readiness loop whose probe never returns
 * never gets back to checking its own deadline. `load` hangs forever instead of
 * failing after a minute, which is the worst version of this: no error, no
 * spoken message, and nothing in the log after "waiting for OpenCode".
 *
 * This happened. The socket below is a reproduction of it.
 */

import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { after, test } from "node:test";

import { OpenCodeClient } from "./client.ts";

const sockets: Socket[] = [];
let server: Server | undefined;

after(() => {
  for (const socket of sockets) socket.destroy();
  server?.close();
});

/** Accepts connections and then says nothing at all, forever. */
function silentPort(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((socket) => sockets.push(socket));
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

test("gives up on a port that accepts and then never answers", async () => {
  const port = await silentPort();
  const client = new OpenCodeClient({
    baseUrl: `http://127.0.0.1:${port}`,
    directory: "/workspace",
    agent: "yammer",
  });

  const started = Date.now();
  const outcome = await client.probeAgent(300);
  const elapsed = Date.now() - started;

  assert.equal(outcome, "unreachable");
  // The assertion that matters is that it returned at all. The bound is loose
  // on purpose: this is about not hanging, not about precise timing.
  assert.ok(elapsed < 5_000, `probe took ${elapsed}ms`);
});

import { afterEach, describe, expect, test } from "bun:test";
import { trustedActorFromHeaders } from "./opAuth";

afterEach(() => {
  delete process.env.OP_MESSAGE_TOKEN_BINDINGS;
  delete process.env.OP_MESSAGE_TOKEN;
  delete process.env.OP_MESSAGE_ACTOR_ID;
});

describe("op auth actor-token binding", () => {
  test("a valid token for one agent cannot impersonate the lead", () => {
    process.env.OP_MESSAGE_TOKEN_BINDINGS = JSON.stringify({ bill: "bill-secret", gd: "lead-secret" });
    const spoof = trustedActorFromHeaders(new Headers({ "x-op-token": "bill-secret", "x-actor-id": "gd" }));
    expect(spoof).toMatchObject({ ok: false, status: 401, error: "unauthorized" });
    expect(trustedActorFromHeaders(new Headers({ "x-op-token": "bill-secret", "x-actor-id": "bill" })).ok).toBe(true);
  });

  test("legacy OP_MESSAGE_TOKEN is bound to one explicit actor", () => {
    process.env.OP_MESSAGE_TOKEN = "legacy-secret";
    process.env.OP_MESSAGE_ACTOR_ID = "dex";
    expect(trustedActorFromHeaders(new Headers({ "x-op-token": "legacy-secret", "x-actor-id": "dex" })).ok).toBe(true);
    expect(trustedActorFromHeaders(new Headers({ "x-op-token": "legacy-secret", "x-actor-id": "gd" }))).toMatchObject({ ok: false, status: 403, error: "actor_token_unbound" });
  });
});

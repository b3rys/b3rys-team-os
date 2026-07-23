import { afterEach, describe, expect, test } from "bun:test";
import { trustedActorFromHeaders } from "./opAuth";

afterEach(() => {
  delete process.env.OP_MESSAGE_TOKEN;
});

describe("op auth shared token", () => {
  test("a valid shared token authenticates any valid actor id", () => {
    process.env.OP_MESSAGE_TOKEN = "shared-secret";
    expect(trustedActorFromHeaders(new Headers({ "x-op-token": "shared-secret", "x-actor-id": "bill" }))).toMatchObject({
      ok: true,
      actor: { actor: "bill", source: "op_token" },
    });
    expect(trustedActorFromHeaders(new Headers({ "x-op-token": "shared-secret", "x-actor-id": "devon" }))).toMatchObject({
      ok: true,
      actor: { actor: "devon", source: "op_token" },
    });
  });

  test("an invalid shared token is rejected", () => {
    process.env.OP_MESSAGE_TOKEN = "shared-secret";
    expect(trustedActorFromHeaders(new Headers({ "x-op-token": "wrong-secret", "x-actor-id": "devon" }))).toMatchObject({
      ok: false,
      status: 401,
      error: "unauthorized",
    });
  });
});

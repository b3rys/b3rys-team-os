import { Hono, type Context } from "hono";
import type { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { runAcceptanceCheck, type AcceptanceDeps } from "../lib/acceptanceCheck";

export interface AcceptanceRouteDeps {
  db: Database;
  registryPath: string;
  teamOsPath: string;
  rootDir?: string;
  membersRoot?: string;
}

function depsForCheck(deps: AcceptanceRouteDeps): AcceptanceDeps {
  return {
    db: deps.db,
    registryPath: deps.registryPath,
    teamOsPath: deps.teamOsPath,
    rootDir: deps.rootDir ?? dirname(dirname(deps.teamOsPath)),
    membersRoot: deps.membersRoot,
  };
}

function cleanMember(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "-") return null;
  return trimmed;
}

export function createAcceptanceRoutes(deps: AcceptanceRouteDeps): Hono {
  const app = new Hono();
  const memberError = (member: string | null) =>
    member && !/^[a-z0-9._-]{1,40}$/i.test(member)
      ? { ok: false, error: "member_invalid", detail: "member must match ^[a-z0-9._-]{1,40}$" }
      : null;

  const runJson = (c: Context, member: string | null) => {
    const error = memberError(member);
    if (error) return c.json(error, 400);
    return c.json(runAcceptanceCheck(depsForCheck(deps), member));
  };

  const runStream = (member: string | null): Response => {
    const result = runAcceptanceCheck(depsForCheck(deps), member);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const section of result.sections) {
          controller.enqueue(encoder.encode(`event: section\ndata: ${JSON.stringify(section)}\n\n`));
        }
        controller.enqueue(encoder.encode(`event: summary\ndata: ${JSON.stringify(result)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, max-age=0, must-revalidate",
        connection: "keep-alive",
      },
    });
  };

  app.get("/members/:member/acceptance-check", (c) => runJson(c, cleanMember(c.req.param("member"))));

  app.get("/members/:member/acceptance-check/stream", (c) => {
    const member = cleanMember(c.req.param("member"));
    const error = memberError(member);
    if (error) return c.json(error, 400);
    return runStream(member);
  });

  app.get("/acceptance-check", (c) => {
    const member = cleanMember(c.req.query("member"));
    return runJson(c, member);
  });

  app.get("/acceptance-check/:member", (c) => runJson(c, cleanMember(c.req.param("member"))));

  app.get("/acceptance-check/:member/stream", (c) => {
    const member = cleanMember(c.req.param("member"));
    const error = memberError(member);
    if (error) return c.json(error, 400);
    return runStream(member);
  });

  return app;
}

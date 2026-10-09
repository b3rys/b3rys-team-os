# Type evidence — TypeScript

**What goes wrong:** TypeScript checks types only while compiling. At run time nothing checks them. A type assertion (`x as T`) makes the compiler accept a value as `T` without looking at it, so when the data is different the program does not stop — it keeps running with the wrong value and the mistake shows up later, somewhere else.

## Patterns

| Pattern | What it tells the compiler | Example |
|---|---|---|
| `JSON.parse(s) as T` | "this string always parses into a `T`" | a DB column holding JSON |
| `x as unknown as T` | "forget what you know about `x`; it is a `T`" | forcing a library object into another shape |
| widen then assert: `const v: unknown = user; … v as Admin` | "this value I deliberately forgot is now a different type" | data passed through an `unknown` helper |
| `// @ts-ignore`, `// @ts-expect-error` without a reason | "don't report the error on the next line" | silencing a real mismatch |

## Check where it is read

```ts
// Before — the compiler trusts the assertion; a number in `kind` silently compares false.
const meta = JSON.parse(row.meta_json) as { kind?: string };
return meta.kind === "skill_feedback_request";

// After — one parser checks each field; callers only ever get a checked Meta.
type Meta = { kind?: string };
function parseMeta(raw: string): Meta | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== "object" || v === null) return null;
  const kind = (v as Record<string, unknown>).kind; // SAFETY: v checked to be a non-null object above
  if (kind !== undefined && typeof kind !== "string") return null;
  return { kind };
}
```

A schema library (zod, valibot) does the same job; the point is that the check exists at the boundary, not which library writes it.

## When an assertion is acceptable

- The value was just checked by code on the lines above (`SAFETY:` names that check).
- A library type is wrong and an issue/upstream link explains it.
- `as const` (narrowing a literal) is not a risky assertion.

## Fakes in tests

`mock.module` / `vi.mock` / `jest.mock` replace a module for the whole test file. Replacing an outside system (a third-party SDK, a token reader) is fine, and so is passing a fake into an injected interface. Replacing project functions that the tested code imports directly is the risky case: the real function can change its arguments or stop writing, and the test stays green. Example in this repo: `src/server/workers/slackPoll.test.ts` fakes the Slack token reader (outside — fine) and also `handleAppMention` and `appendAudit` (project functions imported directly — candidates to pass in as dependencies, or to run for real against an in-memory DB with their own test).

## Lint candidates

From `dmmulroy/anti-slop` (Oxlint JS plugin, vendored by copying):

- `no-chained-type-assertions` — `as unknown as T`
- `require-safety-comment-for-type-assertion` — a non-`const` assertion needs a nearby `SAFETY:` line
- `no-widen-then-assert` — widen to `unknown`/`any`/`object`, then assert back
- `no-module-mocking` — `vi.mock` / `jest.mock` (too strict on its own: outside systems and injected interfaces are fine to fake; use with an allow-list or as a warning)

**Limits:** the rules read syntax within one file; they do not run the type checker and cannot see contracts in other files. A `SAFETY:` rule checks that a comment exists, not that it is true — the reviewer still opens the named check.

Turn on per the baseline procedure in `SKILL.md` ("Moving the type-evidence rules up").

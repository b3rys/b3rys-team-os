# Type evidence — Go

**What goes wrong:** a type assertion is checked at run time; without the `ok` form, a failed check panics instead of returning a value the code can handle. In a server, an unrecovered panic in a handler goroutine can take the whole process down.

## Patterns

| Pattern | Failure when wrong |
|---|---|
| `s := v.(string)` | panic |
| `m := v.(map[string]any)` on decoded JSON | panic |
| `json.Unmarshal` into `map[string]any` and reading fields by assertion | panic or zero values used silently |
| ignoring the error: `json.Unmarshal(b, &x)` with no `err` check | zero-value struct used silently |

## Check where it is read

```go
// Before — panics if "kind" is a number.
kind := payload["kind"].(string)

// After — the ok form; decide what a bad value means.
kind, ok := payload["kind"].(string)
if !ok {
    return fmt.Errorf("payload.kind: want string, got %T", payload["kind"])
}
```

Better still: unmarshal into a struct with typed fields and validate required ones once, at the handler boundary.

## When an assertion without `ok` is acceptable

Only when the value was put there by the same package a few lines earlier (e.g. reading back from a `sync.Map` the package alone writes) — and the `SAFETY:` comment says so.

## Fakes in tests

Interfaces are Go's normal seam: a fake passed into an interface is fine — outside systems (HTTP client, clock, third-party API) or the project's own ports. Don't fake the code the test is checking, and give each important real adapter its own test against a temporary resource (`t.TempDir()` SQLite, or `httptest.Server` for HTTP).

## Lint candidates

golangci-lint: `forcetypeassert` (assertion without `ok`), `errcheck` (ignored errors). Turn on per the baseline procedure in `SKILL.md`.

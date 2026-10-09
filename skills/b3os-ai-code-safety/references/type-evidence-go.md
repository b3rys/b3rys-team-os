# Type evidence — Go

**What goes wrong:** a type assertion without the `ok` form panics when the value is a different type. In a server, an unrecovered panic in a handler goroutine can take the whole process down.

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

Interfaces are Go's normal seam: fake the outside system (HTTP client, clock, third-party API) behind an interface; run the project's own store/handler code for real against a temporary database (`t.TempDir()` SQLite, or `httptest.Server` for HTTP).

## Lint candidates

golangci-lint: `forcetypeassert` (assertion without `ok`), `errcheck` (ignored errors). Turn on per the baseline procedure in `SKILL.md`.

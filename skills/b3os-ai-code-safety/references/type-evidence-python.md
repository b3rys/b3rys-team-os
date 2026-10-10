# Type evidence — Python

**What goes wrong:** type hints are not checked when the program runs. `def f(x: int)` accepts a string at run time; only a separate checker (mypy, pyright) reads the hints, and only if it is run. So a hint on outside data is a statement of hope, not a check.

## Patterns

| Pattern | What it does |
|---|---|
| `cast(T, x)` | tells the checker "x is T"; does nothing at run time |
| `x: Any` on a function's input or return | switches the checker off for everything that flows through |
| `# type: ignore` with no error code | hides every checker error on that line, including future ones |
| `data["kind"]` on parsed JSON with no check | `KeyError` or a wrong type used later |

## Check where it is read

```python
# Before — the hint promises a str; nothing enforces it.
meta: dict[str, str] = json.loads(row["meta_json"])
if meta["kind"] == "skill_feedback_request": ...

# After — check once at the boundary.
raw = json.loads(row["meta_json"])
kind = raw.get("kind") if isinstance(raw, dict) else None
if kind is not None and not isinstance(kind, str):
    log.warning("meta_json.kind: want str, got %s", type(kind).__name__)
    kind = None
```

pydantic / dataclass validators do the same job for larger shapes.

## When it is acceptable

- `cast` right after an `isinstance` check the checker cannot follow — `SAFETY:` names that check.
- `# type: ignore[code]` with the specific error code and a reason (a wrong third-party stub).

## Fakes in tests

`unittest.mock.patch` on an outside system (HTTP, clock, SDK), or a fake passed in as a dependency, is fine. Patching project functions that the tested code calls directly keeps the test green after the real function changes; pass them in as dependencies, and test the real one against a temporary resource (`tmp_path`, in-memory SQLite).

## Lint candidates

ruff: `ANN401` (an `Any` annotation on a function's arguments or return — not every `Any`), `PGH003` (`# type: ignore` without an error code — it does not check for a reason). Turn on per the baseline procedure in `SKILL.md`.

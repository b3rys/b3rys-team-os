# Type evidence — Swift

**What goes wrong:** Swift checks types and thread safety while compiling. The forced forms (`as!`, `try!`, `!`) skip a check and **crash the app** when the assumption is false — in release builds too. The concurrency escape hatches skip the compiler's data-race check and can corrupt state silently.

## Patterns

| Pattern | What it skips | Failure when wrong |
|---|---|---|
| `x as! T` | the type check | crash |
| `try! f()` | handling the error | crash |
| `optional!` | the nil check | crash |
| `dict[key]!` | "this key exists" | crash |
| `fatalError(...)`, `precondition(...)` | — (deliberate stop) | crash, release builds included |
| `unsafeBitCast(x, to: T.self)` | the type system entirely (reinterprets memory) | undefined behavior |
| `nonisolated(unsafe)` | data-race check on a variable | silent corruption |
| `@unchecked Sendable` | data-race check on a type | silent corruption |
| `MainActor.assumeIsolated { }` | "am I on the main thread?" at compile time | crash if called off main |

## When a forced form is acceptable

The value that could fail must be **fixed in source**, not computed at run time.

```swift
// Acceptable — the pattern text is written in the code and never changes.
// If it compiled into a working regex once, it does on every machine, every launch.
// SAFETY: fixed pattern; <existing test name> builds it on every run.
private static let pattern = try! NSRegularExpression(pattern: "&(#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});")

// Not acceptable — the pattern comes from the user; a missing bracket crashes the app.
let re = try! NSRegularExpression(pattern: searchField.stringValue)
// Instead: catch the error and tell the user the pattern is invalid.
```

Other acceptable cases: a constructor's own invariant (taking the parent of a path that was already validated), bundled resources the build guarantees, and a lookup table proven complete by a test that iterates every `CaseIterable` case.

## Concurrency escape hatches

Each `nonisolated(unsafe)` / `@unchecked Sendable` / `assumeIsolated` states **which thread or queue guarantees exclusive access**, e.g. "written once at launch before any window opens, read-only after". If no such guarantee can be named, use an actor, a lock, or `@MainActor` instead.

## Fakes in tests

Faking the AI provider or the network is fine (outside the project). Screen state and store decisions are checked on the real code. A test that compares against a copy of its own fixture constants tests nothing.

## Lint candidates

SwiftLint: `force_cast`, `force_try`, `force_unwrapping` (opt-in). Custom regex rules for `nonisolated(unsafe)`, `@unchecked Sendable`, `unsafeBitCast` that fail only when the count rises.

**Counting:** probe/test harness code legitimately uses forced forms; count it separately from product code, or the baseline looks larger than the product risk. Turn on per the baseline procedure in `SKILL.md`.

# Layout-page boundary corpus

This compact fixture is intentionally split by parser tests at every meaningful byte and line boundary.

> A quote begins here.
>
> - A nested item has a continuation
>   across a potential range edge.

| Heading                         | Value  |
| ------------------------------- | ------ |
| Complete row                    | Stable |
| A row with a [reference][later] | `code` |

- Outer item
  - Nested item
    continuation after a possible range edge

```rust
pub fn complete_fence() {
    let greeting = "héllo";
    println!("{greeting}");
}
```

```typescript
export function multilingual(): string {
  return "東京";
}
```

[^later]: A footnote defined after its use.

[later]: fixtures/link-target.md "A definition after its use"

## Deliberately incomplete structures

> An unclosed quote remains readable.
>
> - Its list item has no final terminator.

| Partial heading                  | Value |
| -------------------------------- | ----- |
| Row begins but has no final cell |

```python
def unfinished_fence() -> str:
    return "the source range ends before the closing fence"
```

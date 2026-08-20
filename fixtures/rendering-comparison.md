# Markdown rendering comparison

This fixture is intentionally small and is used to compare Lumen with third-party Markdown applications.

## Text formatting

Plain text, _emphasis_, **strong emphasis**, and `inline code`.

> A blockquote with **strong text** and `code`.

---

## Code block

```rust
fn main() {
    println!("Lumen renders plain code blocks locally.");
}
```

## Lists

- First item
- Second item
  - Nested item

1. First numbered item
2. Second numbered item

## Table

| Feature  | Lumen target       | Notes                         |
| -------- | ------------------ | ----------------------------- |
| Tables   | Supported baseline | Fast static rendering         |
| Raw HTML | Disabled           | Safety and predictable output |

## Extended Markdown candidates

~~Strikethrough~~

- [x] Completed task
- [ ] Pending task

Footnote reference.[^comparison]

[^comparison]: This exercises optional footnote parsing and presentation.

## Link

[Example web link](https://example.com/)

[Jump to the table](#table)

[Open a local fixture](link-target.md#linked-target)

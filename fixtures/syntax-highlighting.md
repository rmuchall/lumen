# Syntax-highlighting fixture

Lumen highlights a deliberately small, locally bundled first-pass language set.

## HTML

```html
<main class="viewer">
  <h1>Lumen</h1>
</main>
```

## CSS

```css
.viewer {
  color: #0284c7;
  padding: 1rem;
}
```

## JavaScript

```javascript
const name = "Lumen";
console.log(name);
```

## TypeScript

```typescript
interface Viewer {
  name: string;
}
```

## C

```c
int main(void) {
  return 0;
}
```

## C++

```cpp
class Viewer {
public:
  const char* name = "Lumen";
};
```

## Rust

```rust
pub fn render(name: &str) {
    println!("{name}");
}
```

## Python

```python
def render(name: str) -> None:
    print(name)
```

## Plain fallback

```toml
[appearance]
theme = "system"
```

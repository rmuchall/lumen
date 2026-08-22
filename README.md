# Lumen

Lumen is a fast, lightweight Markdown viewer for Linux. It renders local files offline and provides reload-on-save, tabs, find, zoom, native file opening, large-document viewing, and local syntax highlighting.

## Install on Ubuntu

Install the Debian package:

```sh
sudo apt install ./Lumen_<version>_amd64.deb
```

Open Markdown files from Nautilus, launch Lumen directly, or pass a path:

```sh
lumen README.md
```

The package registers Lumen as a `text/markdown` viewer.

## Use

| Action                 | Shortcut |
| ---------------------- | -------- |
| Open a file            | `Ctrl+O` |
| Close the current file | `Ctrl+W` |
| Reload                 | `Ctrl+R` |
| Find                   | `Ctrl+F` |
| Zoom in                | `Ctrl+=` |
| Zoom out               | `Ctrl+-` |
| Reset zoom             | `Ctrl+0` |
| Quit                   | `Ctrl+Q` |

The native File, Edit, View, and Help menus expose the same commands and About Lumen. File → Open starts in the current document's directory, or the home directory when no document is open.

When an open file changes on disk, Lumen reloads it automatically, preserves the current reading position as closely as the new file permits, and shows a dismissible **Document reloaded** notification. If the changed file cannot be read, Lumen keeps the last valid page visible and reports the error instead. An explicit Reload preserves position but does not show the file-change notification.

Hover over a link to show its destination. Web links open in the system browser, readable local Markdown links open in Lumen, and in-document anchors stay in the viewer.

## Configuration

Lumen reads optional TOML configuration from `$XDG_CONFIG_HOME/lumen/config.toml`, or `~/.config/lumen/config.toml` when `XDG_CONFIG_HOME` is unset. It never rewrites this file. Invalid configuration is ignored in favour of built-in defaults and produces a warning.

```toml
version = 1

[window]
start_maximized = true

[appearance]
theme = "system"

[tabs]
enabled = true
```

`appearance.theme` accepts `"system"`, `"light"`, or `"dark"`. Tabs are enabled by default. When tabs are disabled, file-manager launches open independent Lumen windows and File → Open replaces the current document.

Configuration changes apply after restart. Lumen offers a restart action when it detects that the file was saved.

## Markdown support

Lumen supports headings, paragraphs, emphasis, strong emphasis, strikethrough, lists, task lists, blockquotes, thematic breaks, links, local images, inline and fenced code, tables, footnotes, GitHub-style alerts, definition lists, superscript, subscript, and hidden YAML/TOML-style frontmatter.

HTML, CSS, JavaScript, TypeScript, C, C++, Rust, and Python code fences receive local syntax highlighting. Unsupported languages remain plain code.

Raw HTML, remote images, and SVG images do not render. Local PNG, JPEG, GIF, and WebP files must be below the opened document's directory. Small embedded Base64 images are supported under a fixed responsiveness limit.

## Privacy

Lumen makes no network requests, loads no remote assets or CDNs, and sends no telemetry. Only an explicit `http` or `https` Markdown link is delegated to the system default browser.

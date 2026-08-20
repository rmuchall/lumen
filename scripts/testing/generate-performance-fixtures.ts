import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultOutputDirectory = resolve(repositoryRoot, "fixtures/performance");
const fixtureKinds = ["prose", "code", "mixed", "malformed"];
const fixtureSizes = [5, 20, 100];
type FixtureKind = (typeof fixtureKinds)[number];
type FixtureSize = (typeof fixtureSizes)[number];
type FixtureOptions = {kinds?: readonly FixtureKind[]; outputDirectory?: string; sizes?: readonly FixtureSize[]};
export type PerformanceFixtureMarker = {label: string; sourceOffset: number};
export type PerformanceFixtureManifest = {
  byteLength: number;
  fixtureFilename: string;
  markers: readonly PerformanceFixtureMarker[];
};
const markerIntervalBytes = 48 * 1024;

function proseSection(index: number): string {
  return (
    `## Reading section ${index}\n\n` +
    "A deterministic prose fixture keeps paragraphs, emphasis, strong text, inline code, and links flowing through the same local parser and viewer path as a long technical document. It deliberately contains enough natural wrapping to exercise reading-column layout at different window widths. [Reference link](https://example.invalid/prose).\n\n" +
    "The reader should be able to move through this document without retaining every earlier paragraph in the browser DOM. Repeated sections provide stable, reproducible content rather than a compressed or synthetic byte stream.\n\n"
  );
}

function codeSection(index: number): string {
  return (
    `## Code section ${index}\n\n` +
    "```rust\n" +
    "pub fn fixture_section(index: usize) -> &'static str {\n" +
    "    match index % 3 {\n" +
    '        0 => "lumen",\n' +
    '        1 => "layout-page",\n' +
    '        _ => "bounded",\n' +
    "    }\n" +
    "}\n" +
    "```\n\n" +
    "```typescript\n" +
    "export function fixtureSection(index: number): string {\n" +
    "  return `section-${index}`;\n" +
    "}\n" +
    "```\n\n"
  );
}

function mixedSection(index: number): string {
  return (
    `## Mixed section ${index}\n\n` +
    "A deterministic mixed fixture exercises ordinary Markdown content. [Reference link](https://example.invalid/mixed).\n\n" +
    "> Rendering should remain responsive while this document grows.\n\n" +
    "| Metric | Observation |\n| --- | --- |\n| Render | Static content |\n| View | Local only |\n\n" +
    "- [ ] Review the rendered section\n- [x] Preserve bounded source\n\n" +
    '```python\ndef fixture_section(index: int) -> str:\n    return f"lumen-{index}"\n```\n\n'
  );
}

function malformedSection(index: number): string {
  return (
    `## Malformed boundary section ${index}\n\n` +
    "> A block quote begins here\n> and deliberately continues into a list\n> - nested item\n>   continuation text\n\n" +
    "| Partial table | Value |\n| --- | --- |\n| complete row | retained |\n| edge row\n\n" +
    "- list item that remains open\n  - nested item with a continuation\n    that reaches the next generated range\n\n" +
    "```rust\n" +
    "pub fn continuing_fence() {\n" +
    `    let section = ${index};\n` +
    '    let description = "the closing fence occurs in a later source range";\n' +
    "}\n" +
    "```\n\n"
  );
}

function sectionFor(kind: FixtureKind, index: number): string {
  if (kind === "prose") {
    return proseSection(index);
  }
  if (kind === "code") {
    return codeSection(index);
  }
  if (kind === "mixed") {
    return mixedSection(index);
  }
  return malformedSection(index);
}

function createFixture(sizeInMebibytes: FixtureSize, createSection: (index: number) => string): string {
  const targetBytes = sizeInMebibytes * 1024 * 1024;
  const header = "# Lumen layout-page fixture\n\nThis generated document is intentionally large.\n\n";
  const terminalMarker = "\n\n## Lumen terminal fixture marker\n\nLUMEN_TERMINAL_MARKER\n";
  const sections = [header];
  let contentBytes = Buffer.byteLength(header, "utf8");
  const terminalMarkerBytes = Buffer.byteLength(terminalMarker, "utf8");
  let index = 1;

  while (contentBytes + terminalMarkerBytes < targetBytes) {
    const nextSection = createSection(index);
    const nextSectionBytes = Buffer.byteLength(nextSection, "utf8");
    if (contentBytes + nextSectionBytes + terminalMarkerBytes > targetBytes) {
      sections.push(" ".repeat(targetBytes - contentBytes - terminalMarkerBytes));
      break;
    }
    sections.push(nextSection);
    contentBytes += nextSectionBytes;
    index += 1;
  }
  sections.push(terminalMarker);
  return sections.join("");
}

function markerManifestPath(fixturePath: string): string {
  return `${fixturePath}.markers.json`;
}

function createMarkerManifest(fixtureFilename: string, source: string): PerformanceFixtureManifest {
  const markers: PerformanceFixtureMarker[] = [{label: "Lumen layout-page fixture", sourceOffset: 0}];
  const headingPattern = /^## (?:Reading|Code|Mixed|Malformed boundary) section \d+$/gm;
  let nextMarkerOffset = markerIntervalBytes;
  for (const match of source.matchAll(headingPattern)) {
    const sourceOffset = match.index ?? 0;
    if (sourceOffset < nextMarkerOffset) {
      continue;
    }
    markers.push({label: match[0].slice(3), sourceOffset});
    nextMarkerOffset = sourceOffset + markerIntervalBytes;
  }
  const terminalLabel = "LUMEN_TERMINAL_MARKER";
  const terminalOffset = source.lastIndexOf(terminalLabel);
  if (terminalOffset < 0) {
    throw new Error(`${fixtureFilename} does not contain its terminal marker`);
  }
  markers.push({label: terminalLabel, sourceOffset: terminalOffset});
  return {byteLength: Buffer.byteLength(source, "utf8"), fixtureFilename, markers};
}

function writeMissingMarkerManifest(fixturePath: string, fixtureFilename: string, source: string): void {
  const manifestPath = markerManifestPath(fixturePath);
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify(createMarkerManifest(fixtureFilename, source))}\n`, "utf8");
  }
}

function markerManifestIsPresent(fixturePath: string): boolean {
  return existsSync(markerManifestPath(fixturePath));
}

export function performanceFixtureMarkerManifestPath(fixturePath: string): string {
  return markerManifestPath(fixturePath);
}

function selectedValues<T extends string>(
  argument: string | undefined,
  allowedValues: readonly T[],
  label: string,
): readonly T[] {
  if (argument === undefined) {
    return allowedValues;
  }
  const values = argument.split(",");
  if (values.length === 0 || values.some((value) => !(allowedValues as readonly string[]).includes(value))) {
    throw new Error(`invalid ${label}: ${argument}`);
  }
  return values as T[];
}

export function generatePerformanceFixtures({
  kinds = fixtureKinds,
  outputDirectory = defaultOutputDirectory,
  sizes = fixtureSizes,
}: FixtureOptions = {}): void {
  mkdirSync(outputDirectory, {recursive: true});
  for (const sizeInMebibytes of sizes) {
    for (const kind of kinds) {
      const filename = `lumen-${kind}-${sizeInMebibytes}mib.md`;
      const path = resolve(outputDirectory, filename);
      if (!existsSync(path)) {
        const source = createFixture(sizeInMebibytes, (index) => sectionFor(kind, index));
        writeFileSync(path, source, "utf8");
        writeMissingMarkerManifest(path, filename, source);
      } else if (!markerManifestIsPresent(path)) {
        writeMissingMarkerManifest(path, filename, readFileSync(path, "utf8"));
      }
    }
  }
}

function parseArguments(): Pick<Required<FixtureOptions>, "kinds" | "sizes"> {
  const argumentsByName = new Map<string, string>();
  const argumentsList = process.argv.slice(2);
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if ((name !== "--kinds" && name !== "--sizes") || value === undefined || argumentsByName.has(name)) {
      throw new Error(
        "usage: node scripts/testing/generate-performance-fixtures.ts [--kinds prose,code,mixed,malformed] [--sizes 5,20,100]",
      );
    }
    argumentsByName.set(name, value);
  }
  return {
    kinds: selectedValues(argumentsByName.get("--kinds"), fixtureKinds, "fixture kinds"),
    sizes: selectedValues(argumentsByName.get("--sizes"), fixtureSizes.map(String), "fixture sizes").map(
      Number,
    ) as FixtureSize[],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generatePerformanceFixtures(parseArguments());
}

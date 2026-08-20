import {access, mkdir, writeFile} from "node:fs/promises";
import {dirname, relative, resolve} from "node:path";

export const performanceScenarioNames = ["baseline", "scroll-drag", "wheel", "tabs", "enrichment"] as const;

export type PerformanceScenarioName = (typeof performanceScenarioNames)[number];

export type PerformanceRunArguments = {
  recordPath: string;
  scenario: PerformanceScenarioName;
};

export type PerformanceFixtureRecord = {
  bytes: number;
  checksum: string;
  documentClass: string;
  filename: string;
};

export type PerformanceScenarioRecord = {
  cold: boolean;
  name: string;
  rawSamples: Readonly<Record<string, unknown>>;
  summary: Readonly<Record<string, unknown>>;
};

export type PerformanceRecord = {
  build: Readonly<Record<string, string>>;
  collectorSchemaVersion: number;
  conclusion: string;
  correctness: Readonly<Record<string, unknown>>;
  environment: Readonly<Record<string, string>>;
  fixtures: readonly PerformanceFixtureRecord[];
  scenarios: readonly PerformanceScenarioRecord[];
};

function isPerformanceScenarioName(value: string): value is PerformanceScenarioName {
  return (performanceScenarioNames as readonly string[]).includes(value);
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const pathRelativeToParent = relative(parentPath, candidatePath);
  return pathRelativeToParent !== "" && !pathRelativeToParent.startsWith("../") && pathRelativeToParent !== "..";
}

export function parsePerformanceRunArguments(
  argumentsList: readonly string[],
  repositoryRoot: string,
): PerformanceRunArguments {
  if (argumentsList.length !== 4) {
    throw new Error(
      "usage: node scripts/testing/run-suite.ts --performance --scenario <baseline|scroll-drag|wheel|tabs|enrichment> --record performance/<name>.md",
    );
  }
  const argumentsByName = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if ((name !== "--scenario" && name !== "--record") || value === undefined || argumentsByName.has(name)) {
      throw new Error("performance collection requires one --scenario and one --record argument");
    }
    argumentsByName.set(name, value);
  }
  const scenario = argumentsByName.get("--scenario");
  const recordArgument = argumentsByName.get("--record");
  if (scenario === undefined || !isPerformanceScenarioName(scenario)) {
    throw new Error(`invalid performance scenario: ${scenario ?? "missing"}`);
  }
  if (recordArgument === undefined || !recordArgument.endsWith(".md")) {
    throw new Error("performance record must be a Markdown file below performance/");
  }
  const performanceDirectory = resolve(repositoryRoot, "performance");
  const recordPath = resolve(repositoryRoot, recordArgument);
  if (!isPathWithin(performanceDirectory, recordPath)) {
    throw new Error("performance record must resolve below performance/");
  }
  return {recordPath, scenario};
}

function markdownValue(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderTable(values: Readonly<Record<string, string>>): string {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  return [
    "| Field | Value |",
    "| --- | --- |",
    ...entries.map(([key, value]) => `| ${key} | ${markdownValue(value)} |`),
  ].join("\n");
}

export function renderPerformanceRecord(record: PerformanceRecord): string {
  const fixtureRows = record.fixtures
    .map(
      (fixture) =>
        `| ${markdownValue(fixture.filename)} | ${fixture.bytes} | ${markdownValue(fixture.documentClass)} | \`${fixture.checksum}\` |`,
    )
    .join("\n");
  const scenarioSections = record.scenarios
    .map(
      (scenario) =>
        `### ${scenario.name}\n\nSample type: ${scenario.cold ? "cold" : "warm"}.\n\n#### Summary\n\n\`\`\`json\n${JSON.stringify(
          scenario.summary,
          null,
          2,
        )}\n\`\`\`\n\n#### Raw samples\n\n\`\`\`json\n${JSON.stringify(scenario.rawSamples, null, 2)}\n\`\`\``,
    )
    .join("\n\n");
  return `# Performance record\n\nCollector schema: ${record.collectorSchemaVersion}.\n\n## Environment\n\n${renderTable(
    record.environment,
  )}\n\n## Build and configuration\n\n${renderTable(record.build)}\n\n## Fixtures\n\n| Fixture | Bytes | Document class | SHA-256 |\n| --- | ---: | --- | --- |\n${fixtureRows}\n\n## Scenario\n\n${scenarioSections}\n\n## Correctness and resource checks\n\n\`\`\`json\n${JSON.stringify(
    record.correctness,
    null,
  )}\n\`\`\`\n\n## Conclusion\n\n${record.conclusion}\n`;
}

export async function assertPerformanceRecordAvailable(recordPath: string): Promise<void> {
  try {
    await access(recordPath);
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`performance record already exists: ${recordPath}`);
}

export async function writePerformanceRecord(recordPath: string, record: PerformanceRecord): Promise<void> {
  await mkdir(dirname(recordPath), {recursive: true});
  await writeFile(recordPath, renderPerformanceRecord(record), {encoding: "utf8", flag: "wx"});
}

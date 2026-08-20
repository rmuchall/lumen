import {mkdtemp, readFile, rm} from "node:fs/promises";
import {join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {
  assertPerformanceRecordAvailable,
  parsePerformanceRunArguments,
  renderPerformanceRecord,
  writePerformanceRecord,
  type PerformanceRecord,
} from "./performance-metrics.ts";

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectFailure(action: () => unknown, description: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`${description} unexpectedly completed`);
}

const exampleRecord: PerformanceRecord = {
  build: {version: "0.1.32"},
  collectorSchemaVersion: 1,
  conclusion: "Collector contract fixture.",
  correctness: {passed: true},
  environment: {host: "test-host"},
  fixtures: [{bytes: 1024, checksum: "abc123", documentClass: "mixed", filename: "fixture.md"}],
  scenarios: [{cold: false, name: "scroll-drag", rawSamples: {sample: 1}, summary: {medianMilliseconds: 1}}],
};

async function run(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lumen-performance-record-test-"));
  try {
    const parsed = parsePerformanceRunArguments(
      ["--scenario", "scroll-drag", "--record", "performance/candidate.md"],
      root,
    );
    assertCondition(parsed.scenario === "scroll-drag", "valid performance scenario was not parsed");
    assertCondition(parsed.recordPath === resolve(root, "performance/candidate.md"), "record path was not resolved");
    await expectFailure(
      () => parsePerformanceRunArguments(["--scenario", "invalid", "--record", "performance/candidate.md"], root),
      "invalid scenario",
    );
    await expectFailure(
      () => parsePerformanceRunArguments(["--scenario", "baseline", "--record", "../outside.md"], root),
      "record outside performance directory",
    );
    await expectFailure(
      () => parsePerformanceRunArguments(["--scenario", "baseline", "--record", "performance/candidate.json"], root),
      "non-Markdown record",
    );

    const rendered = renderPerformanceRecord(exampleRecord);
    for (const heading of [
      "## Environment",
      "## Build and configuration",
      "## Fixtures",
      "## Scenario",
      "## Correctness and resource checks",
      "## Conclusion",
    ]) {
      assertCondition(rendered.includes(heading), `record renderer omitted ${heading}`);
    }
    await writePerformanceRecord(parsed.recordPath, exampleRecord);
    assertCondition(
      (await readFile(parsed.recordPath, "utf8")) === rendered,
      "record writer did not preserve the rendered schema",
    );
    await expectFailure(() => assertPerformanceRecordAvailable(parsed.recordPath), "existing record availability");
    await expectFailure(() => writePerformanceRecord(parsed.recordPath, exampleRecord), "record overwrite");
  } finally {
    await rm(root, {force: true, recursive: true});
  }
}

await run();
process.stdout.write("performance metrics contract passed\n");

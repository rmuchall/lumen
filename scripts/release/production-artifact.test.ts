import {readdir, readFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distributionDirectory = join(repositoryRoot, "web", "dist");
const releaseExecutable = join(repositoryRoot, "src-tauri", "target", "release", "lumen");
const forbiddenFragments = ["agent-api-v1", "agent-event-", "report_agent_event_completion", "scripts/agent-api"];
const startedAt = Date.now();

async function distributionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? distributionFiles(path) : [path];
    }),
  );
  return files.flat();
}

async function assertExcludesAgentApi(file: string): Promise<void> {
  const content = await readFile(file);
  for (const fragment of forbiddenFragments) {
    if (content.includes(Buffer.from(fragment))) {
      throw new Error(`production artifact retains Agent API fragment ${fragment}: ${file}`);
    }
  }
}

for (const file of await distributionFiles(distributionDirectory)) {
  await assertExcludesAgentApi(file);
}
await assertExcludesAgentApi(releaseExecutable);

await new Promise<void>((resolveWrite, rejectWrite) => {
  process.stdout.write(
    `test:production-artifact complete status=passed total=${Date.now() - startedAt}ms\n`,
    (error) => {
      if (error === undefined || error === null) {
        resolveWrite();
      } else {
        rejectWrite(error);
      }
    },
  );
});

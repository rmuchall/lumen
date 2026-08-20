import {readdir, readFile, readlink, lstat, rm, stat} from "node:fs/promises";
import {basename, join, resolve} from "node:path";
import {connect} from "node:net";
import {setTimeout as sleep} from "node:timers/promises";
import {fileURLToPath, pathToFileURL} from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const processShutdownTimeoutMilliseconds = 3_000;
const pollIntervalMilliseconds = 50;
const agentQuitTimeoutMilliseconds = 500;
const currentUserIdentifier = process.getuid?.();

if (currentUserIdentifier === undefined) {
  throw new Error("test environment cleanup requires a Unix user identifier");
}

type ProcessEntry = {
  command: string;
  cwd: string | null;
  executable: string | null;
  parentProcessIdentifier: number;
  processIdentifier: number;
};

function processIdentifiersFromDirectoryNames(directoryNames: readonly string[]): number[] {
  return directoryNames.flatMap((name) => {
    const processIdentifier = Number(name);
    return Number.isSafeInteger(processIdentifier) && processIdentifier > 0 ? [processIdentifier] : [];
  });
}

async function readProcessEntry(processIdentifier: number): Promise<ProcessEntry | null> {
  try {
    const processDirectory = `/proc/${processIdentifier}`;
    if ((await stat(processDirectory)).uid !== currentUserIdentifier) {
      return null;
    }
    const [commandBytes, currentDirectory, executable, statLine] = await Promise.all([
      readFile(join(processDirectory, "cmdline")),
      readlink(join(processDirectory, "cwd")).catch(() => null),
      readlink(join(processDirectory, "exe")).catch(() => null),
      readFile(join(processDirectory, "stat"), "utf8"),
    ]);
    const fields = statLine
      .slice(statLine.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    const parentProcessIdentifier = Number(fields[1]);
    if (!Number.isSafeInteger(parentProcessIdentifier)) {
      return null;
    }
    return {
      command: commandBytes.toString("utf8").replaceAll("\0", " ").trim(),
      cwd: currentDirectory,
      executable,
      parentProcessIdentifier,
      processIdentifier,
    };
  } catch {
    return null;
  }
}

async function runningProcesses(): Promise<ProcessEntry[]> {
  const entries = await readdir("/proc", {withFileTypes: true});
  const processIdentifiers = processIdentifiersFromDirectoryNames(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );
  const processes = await Promise.all(processIdentifiers.map(readProcessEntry));
  return processes.flatMap((entry) => (entry === null ? [] : [entry]));
}

function isLumenProcess(entry: ProcessEntry): boolean {
  return entry.executable !== null && basename(entry.executable) === "lumen";
}

function isRepositoryDevelopmentResource(entry: ProcessEntry): boolean {
  if (entry.cwd !== repositoryRoot || entry.executable === null || basename(entry.executable) !== "node") {
    return false;
  }
  return (
    entry.command.includes("tauri dev") ||
    entry.command.includes("node_modules/.bin/vite") ||
    entry.command.includes("node_modules/vite/")
  );
}

function processTree(processes: readonly ProcessEntry[], roots: ReadonlySet<number>): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.parentProcessIdentifier) ?? [];
    children.push(process.processIdentifier);
    childrenByParent.set(process.parentProcessIdentifier, children);
  }
  const selected = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const processIdentifier = pending.pop();
    if (processIdentifier === undefined) {
      continue;
    }
    for (const child of childrenByParent.get(processIdentifier) ?? []) {
      if (!selected.has(child)) {
        selected.add(child);
        pending.push(child);
      }
    }
  }
  return selected;
}

function agentSocketPath(entry: ProcessEntry): string | null {
  const argumentsList = entry.command.split(" ");
  const optionIndex = argumentsList.indexOf("--agent-socket");
  return optionIndex >= 0 ? (argumentsList[optionIndex + 1] ?? null) : null;
}

async function requestAgentQuit(socketPath: string): Promise<void> {
  await new Promise<void>((resolveRequest) => {
    const connection = connect(socketPath);
    const timeout = setTimeout(() => {
      connection.destroy();
      resolveRequest();
    }, agentQuitTimeoutMilliseconds);
    connection.once("error", () => {
      clearTimeout(timeout);
      resolveRequest();
    });
    connection.once("connect", () => connection.end("quit\n"));
    connection.once("end", () => {
      clearTimeout(timeout);
      resolveRequest();
    });
  });
}

function terminate(processIdentifiers: ReadonlySet<number>, signal: NodeJS.Signals): void {
  for (const processIdentifier of processIdentifiers) {
    try {
      process.kill(processIdentifier, signal);
    } catch {
      // The process may have exited after its Agent API quit request.
    }
  }
}

async function waitForExit(processIdentifiers: ReadonlySet<number>): Promise<Set<number>> {
  const deadline = Date.now() + processShutdownTimeoutMilliseconds;
  let remaining = new Set(processIdentifiers);
  while (Date.now() < deadline && remaining.size > 0) {
    remaining = new Set(
      [...remaining].filter((processIdentifier) => {
        try {
          process.kill(processIdentifier, 0);
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (remaining.size > 0) {
      await sleep(pollIntervalMilliseconds);
    }
  }
  return remaining;
}

async function removeSocket(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSocket()) {
      await rm(path, {force: true});
    }
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function removeTemporaryTestRoots(): Promise<void> {
  const temporaryDirectory = "/tmp";
  const entries = await readdir(temporaryDirectory, {withFileTypes: true});
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("lumen-test-"))
      .map((entry) => rm(join(temporaryDirectory, entry.name), {force: true, recursive: true})),
  );
  await Promise.all(
    entries
      .filter((entry) => entry.isSocket() && entry.name.startsWith("lumen-") && entry.name.endsWith(".sock"))
      .map((entry) => removeSocket(join(temporaryDirectory, entry.name))),
  );
}

async function removeHandoffSocket(): Promise<void> {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  if (runtimeDirectory !== undefined) {
    await removeSocket(join(runtimeDirectory, "lumen", "open.sock"));
  }
}

async function staleTemporaryResourceCount(): Promise<number> {
  const temporaryDirectory = "/tmp";
  const entries = await readdir(temporaryDirectory, {withFileTypes: true});
  const temporaryResources = entries.filter((entry) => {
    return (
      (entry.isDirectory() && entry.name.startsWith("lumen-test-")) ||
      (entry.isSocket() && entry.name.startsWith("lumen-") && entry.name.endsWith(".sock"))
    );
  });
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  if (runtimeDirectory === undefined) {
    return temporaryResources.length;
  }
  try {
    const handoffSocket = await lstat(join(runtimeDirectory, "lumen", "open.sock"));
    return temporaryResources.length + Number(handoffSocket.isSocket());
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return temporaryResources.length;
    }
    throw error;
  }
}

export async function assertTestEnvironmentClean(): Promise<void> {
  const remainingProcesses = (await runningProcesses()).filter(
    (entry) => isLumenProcess(entry) || isRepositoryDevelopmentResource(entry),
  );
  const staleResources = await staleTemporaryResourceCount();
  if (remainingProcesses.length > 0 || staleResources > 0) {
    const processList = remainingProcesses.map((entry) => `${entry.processIdentifier}:${entry.command}`).join("; ");
    throw new Error(
      `test environment cleanup incomplete: processes=${processList || "none"} stale_resources=${staleResources}`,
    );
  }
}

export async function cleanTestEnvironment(): Promise<void> {
  const processes = await runningProcesses();
  const roots = new Set(
    processes
      .filter((entry) => isLumenProcess(entry) || isRepositoryDevelopmentResource(entry))
      .map((entry) => entry.processIdentifier),
  );
  const selectedProcesses = processTree(processes, roots);
  await Promise.all(
    processes
      .filter((entry) => selectedProcesses.has(entry.processIdentifier))
      .flatMap((entry) => {
        const socketPath = agentSocketPath(entry);
        return socketPath === null ? [] : [requestAgentQuit(socketPath)];
      }),
  );
  const agentSockets = processes
    .filter((entry) => selectedProcesses.has(entry.processIdentifier))
    .flatMap((entry) => {
      const socketPath = agentSocketPath(entry);
      return socketPath === null ? [] : [socketPath];
    });
  terminate(selectedProcesses, "SIGTERM");
  const remainingProcesses = await waitForExit(selectedProcesses);
  if (remainingProcesses.size > 0) {
    terminate(remainingProcesses, "SIGKILL");
    const survivingProcesses = await waitForExit(remainingProcesses);
    if (survivingProcesses.size > 0) {
      throw new Error(`could not stop Lumen test resources: ${[...survivingProcesses].join(",")}`);
    }
  }
  await Promise.all([removeTemporaryTestRoots(), removeHandoffSocket(), ...agentSockets.map(removeSocket)]);
  await assertTestEnvironmentClean();
  process.stdout.write(`test environment clean: stopped=${selectedProcesses.size}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cleanTestEnvironment();
}

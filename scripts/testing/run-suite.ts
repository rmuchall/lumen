import {spawn} from "node:child_process";
import {lstat, mkdir, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, isAbsolute, join, resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

type SuiteInvocation = {
  receiptPath: string;
  suiteArguments: readonly string[];
};

type SuiteReceipt = {
  completion: string | null;
  error: string | null;
  name: string;
  outputContract: "passed" | "failed";
  status: "passed" | "failed";
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function childFailureMessage(name: string, exitCode: number | null, standardOutput: string): string {
  const failure = standardOutput.match(new RegExp(`^test:${name} failed total=\\d+ms$`, "m"))?.[0];
  const detail = standardOutput.match(/^Error: .+$/m)?.[0];
  return [failure, detail, `test:${name} exited with ${exitCode ?? "no exit code"}`].filter(Boolean).join("; ");
}

function requestedSuiteInvocation(argumentsList: readonly string[]): {
  receiptPath: string | null;
  suiteArguments: readonly string[];
} {
  const receiptIndex = argumentsList.indexOf("--receipt");
  if (receiptIndex === -1) {
    return {receiptPath: null, suiteArguments: argumentsList};
  }
  if (argumentsList.lastIndexOf("--receipt") !== receiptIndex) {
    throw new Error("--receipt may be supplied only once");
  }
  const receiptPath = argumentsList[receiptIndex + 1];
  if (receiptPath === undefined || !isAbsolute(receiptPath)) {
    throw new Error("--receipt requires an absolute output path");
  }
  return {
    receiptPath,
    suiteArguments: [...argumentsList.slice(0, receiptIndex), ...argumentsList.slice(receiptIndex + 2)],
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function assertReceiptPathAvailable(receiptPath: string): Promise<void> {
  const parent = await stat(dirname(receiptPath));
  if (!parent.isDirectory()) {
    throw new Error(`receipt parent is not a directory: ${dirname(receiptPath)}`);
  }
  try {
    await lstat(receiptPath);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  throw new Error(`receipt path already exists: ${receiptPath}`);
}

async function durableReceiptPath(name: string, requestedPath: string | null): Promise<string> {
  if (requestedPath !== null) {
    await assertReceiptPathAvailable(requestedPath);
    return requestedPath;
  }
  const receiptDirectory = join(tmpdir(), "lumen-receipts");
  await mkdir(receiptDirectory, {recursive: true});
  const receiptPath = join(receiptDirectory, `${name}-${process.pid}-${randomUUID()}.json`);
  await assertReceiptPathAvailable(receiptPath);
  return receiptPath;
}

function suiteName(argumentsForSuite: readonly string[]): string {
  if (argumentsForSuite.length === 0) {
    return "critical";
  }
  if (argumentsForSuite[0] === "--performance") {
    return "performance";
  }
  if ((argumentsForSuite[0] === "--tier" || argumentsForSuite[0] === "--case") && argumentsForSuite.length === 2) {
    return argumentsForSuite[1] ?? "unknown";
  }
  throw new Error(
    "usage: node scripts/testing/run-suite.ts [--tier <tier>] [--case <case>] [--performance --scenario <scenario> --record performance/<name>.md]",
  );
}

function writeTo(stream: NodeJS.WriteStream, chunk: Buffer): void {
  stream.write(chunk);
}

async function writeOutput(message: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(message, (error) => {
      if (error === undefined || error === null) {
        resolveWrite();
      } else {
        rejectWrite(error);
      }
    });
  });
}

async function writeReceipt(path: string, receipt: SuiteReceipt): Promise<void> {
  await writeFile(path, `${JSON.stringify(receipt)}\n`, {encoding: "utf8", flag: "wx", mode: 0o600});
}

async function runSuite(): Promise<void> {
  const requestedInvocation = requestedSuiteInvocation(process.argv.slice(2));
  const name = suiteName(requestedInvocation.suiteArguments);
  const invocation: SuiteInvocation = {
    receiptPath: await durableReceiptPath(name, requestedInvocation.receiptPath),
    suiteArguments: requestedInvocation.suiteArguments,
  };
  await writeOutput(`test:${name} receipt-path=${invocation.receiptPath}\n`);
  let receiptWritten = false;
  try {
    const child = spawn(process.execPath, ["scripts/testing/run-tier.ts", ...invocation.suiteArguments], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let standardOutput = "";
    let standardError = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      standardOutput += chunk.toString("utf8");
      writeTo(process.stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      standardError += chunk.toString("utf8");
      writeTo(process.stderr, chunk);
    });

    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code) => resolveExit(code));
    });
    const completionPattern = new RegExp(`^test:${name} complete status=passed total=\\d+ms$`, "gm");
    const completions = standardOutput.match(completionPattern) ?? [];
    if (exitCode !== 0) {
      throw new Error(childFailureMessage(name, exitCode, `${standardOutput}\n${standardError}`));
    }
    if (completions.length !== 1) {
      throw new Error(`test:${name} completion receipt invalid: expected one, received ${completions.length}`);
    }
    await writeOutput(`test:${name} output-contract=passed\n`);
    await writeReceipt(invocation.receiptPath, {
      completion: completions[0] ?? null,
      error: null,
      name,
      outputContract: "passed",
      status: "passed",
    });
    receiptWritten = true;
  } catch (error: unknown) {
    if (!receiptWritten) {
      await writeReceipt(invocation.receiptPath, {
        completion: null,
        error: errorMessage(error),
        name,
        outputContract: "failed",
        status: "failed",
      });
    }
    throw error;
  }
}

await runSuite();

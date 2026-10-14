import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { OperatorAuth } from "./operator-auth.js";
import { readHiddenPassword } from "./operator-hidden-password.js";

type Io = {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WritableStream;
};

/** `init ABSOLUTE_AUTH_FILE`; `ensemble service init-auth` shares it. */
export async function runOperatorAuth(
  argv: string[],
  io: Io = process,
): Promise<number> {
  const [command, authFile, ...extra] = argv;
  if (
    command !== "init" ||
    !authFile ||
    extra.length > 0 ||
    !isAbsolute(authFile)
  ) {
    io.stderr.write(
      "Usage: npm run operator-auth -- init ABSOLUTE_AUTH_FILE\n",
    );
    return 2;
  }
  try {
    const password = await readHiddenPassword(io.stdin, io.stdout);
    await OperatorAuth.initialize(authFile, password);
    io.stdout.write("Operator authentication initialized\n");
    return 0;
  } catch {
    io.stderr.write("Operator authentication initialization failed\n");
    return 1;
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runOperatorAuth(process.argv.slice(2));

/**
 * Import first in every command-line entry point. Turns thrown errors (a missing file, an
 * unknown flag, no API key) into one line on stderr and exit code 1, instead of a stack trace.
 * Set DEBUG=1 to see the stack.
 */
export function fail(err: unknown): never {
  if (process.env.DEBUG) console.error(err);
  else console.error(`error: ${friendly(err)}`);
  process.exit(1);
}

function friendly(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOENT" && e.path) return `file not found: ${e.path}`;
  if (e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || e.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return `${e.message.split(". ")[0]} (see the usage in README.md)`;
  }
  return e.message;
}

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);


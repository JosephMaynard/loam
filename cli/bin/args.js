// Argument parsing for the `loam` launcher (bin/loam.js). Kept separate so it's testable
// (cli/test/args.test.mjs). Every option is listed here, so a flag loam doesn't know is refused rather than
// ignored (`loam --prot 4000` used to start on the default port without a word), and a value can be given
// either way: `--port 4000` or `--port=4000`.

/**
 * The options `loam` takes. `value`: "required" (the option needs one), "optional" (`--encrypt` works bare
 * or with one), "none" (a switch). `key` is the field it sets on the parsed flags.
 */
export const OPTIONS = [
  { name: "--port", key: "port", value: "required" },
  { name: "--data-dir", key: "dataDir", value: "required" },
  { name: "--encrypt", key: "encrypt", value: "optional" },
  { name: "--kiosk", key: "kiosk", value: "none" },
  { name: "--plain", key: "plain", value: "none" },
  { name: "--verbose", key: "verbose", value: "none" },
  { name: "--help", key: "help", value: "none", aliases: ["-h"] },
];

/** The option named `name` (an alias counts), or undefined. */
function optionNamed(name) {
  return OPTIONS.find((option) => option.name === name || option.aliases?.includes(name));
}

/** "--port, --data-dir, --encrypt, --kiosk, --plain, --verbose, --help (-h)": for a refusal. */
export function knownOptions() {
  return OPTIONS.map((option) => (option.aliases ? `${option.name} (${option.aliases.join(", ")})` : option.name)).join(", ");
}

/**
 * Parse the arguments after the script name. Returns `{ flags }`, where a switch is a boolean, a valued
 * option is its string (`encrypt` is `true` when given bare) and an absent option is undefined, or
 * `{ error }` with the one line to print before exiting: an option loam doesn't know, a stray argument, a
 * value missing or empty, or a valued option given twice. A token that starts with `-` never serves as a
 * value, so `--data-dir -bad` is refused rather than read as a folder called "-bad".
 */
export function parseArgs(argv) {
  const flags = { kiosk: false, plain: false, verbose: false, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("-") || token === "-") {
      return { error: `Unexpected argument "${token}": loam takes options only (${knownOptions()}). See \`loam --help\`.` };
    }
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const inline = equals >= 0 ? token.slice(equals + 1) : undefined;
    const option = optionNamed(name);
    if (!option) {
      return { error: `Unknown option "${name}". Known options: ${knownOptions()}. See \`loam --help\`.` };
    }
    if (option.value === "none") {
      if (inline !== undefined) {
        return { error: `${option.name} takes no value. See \`loam --help\`.` };
      }
      flags[option.key] = true;
      continue;
    }
    if (seen.has(option.name)) {
      return { error: `${option.name} was given more than once.` };
    }
    seen.add(option.name);
    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next !== undefined && next !== "" && !String(next).startsWith("-")) {
        value = String(next);
        index += 1;
      }
    }
    if (value === "") {
      return { error: `${option.name}= needs a value after the "=". See \`loam --help\`.` };
    }
    if (value === undefined) {
      if (option.value === "required") {
        return { error: `${option.name} requires a value. See \`loam --help\`.` };
      }
      flags[option.key] = true;
      continue;
    }
    flags[option.key] = value;
  }
  return { flags };
}

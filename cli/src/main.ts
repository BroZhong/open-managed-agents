#!/usr/bin/env node
import { parse, prepare } from "./input.js";
import { Http } from "./http.js";
import { render } from "./output.js";
import { CliError, invalid, normalizeError, redact } from "./errors.js";
import { agents } from "./commands/agents.js";
import { files } from "./commands/files.js";
import { skills } from "./commands/skills.js";
import { transfers } from "./commands/transfers.js";
import { sessions } from "./commands/sessions.js";
import { discovery, help, version } from "./commands/discovery.js";
const commands = [...agents, ...files, ...skills, ...transfers, ...sessions];
let schemaPath = "";
commands.push(...discovery(commands, () => schemaPath));
const controller = new AbortController();
process.once("SIGINT", () => {
  process.stdin.destroy();
  controller.abort(
    new CliError(
      {
        type: "interrupted",
        subtype: "sigint",
        message: "Local operation interrupted",
        hint: "Inspect remote state; remote execution has not been interrupted.",
        retryable: false,
      },
      130,
    ),
  );
});
let secret = process.env.OMA_API_KEY ?? "";
try {
  const { words, flags } = parse(process.argv.slice(2), commands);
  secret = flags["api-key"] ?? secret;
  if (flags.version) {
    process.stdout.write(version + "\n");
  } else if (flags.help || !words.length) {
    process.stdout.write(help(commands, words.join(" ")));
  } else {
    if (words[0] === "schema") {
      schemaPath = words.slice(1).join(" ");
      words.splice(1);
    }
    const command = commands.find((c) => c.path === words.join(" "));
    if (!command) invalid("Unknown command; run oma-cli --help");
    const inputs = await prepare(command, flags);
    controller.signal.throwIfAborted();
    const http = new Http(inputs.flags, controller.signal);
    if (!command.offline) http.configured();
    const result = await command.run({
      ...inputs,
      http,
      signal: controller.signal,
      command,
      write: (s) => process.stdout.write(s),
    });
    process.stdout.write(render(command, result, inputs.flags));
    if (result.ok === false)
      process.stderr.write(
        JSON.stringify({
          ok: false,
          error: {
            type: "partial_failure",
            subtype: "partial_failure",
            message: "Some items failed or have unknown results",
            hint: "Inspect each item before retrying; successful items were retained.",
            retryable: false,
          },
        }) + "\n",
      );
    process.exitCode = result.code ?? 0;
  }
} catch (e) {
  const error = normalizeError(
    controller.signal.aborted ? controller.signal.reason : e,
  );
  process.stderr.write(
    JSON.stringify({ ok: false, error: redact(error.info, [secret]) }) + "\n",
  );
  process.exitCode = error.code;
}

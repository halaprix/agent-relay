import { EXIT_CLASSES } from "./constants.mjs";

export function ok(command, data = {}, notes = []) {
  return result("success", command, data, notes);
}

export function result(exitClass, command, data = {}, notes = []) {
  return {
    ok: exitClass === "success",
    exitClass,
    exitCode: EXIT_CLASSES[exitClass],
    command,
    notes,
    ...data
  };
}

export function printResult(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

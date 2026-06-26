export function parseCliArgs(argv) {
  const args = [...argv];
  const jsonFlagIndex = args.indexOf("--json");
  if (jsonFlagIndex >= 0) {
    args.splice(jsonFlagIndex, 1);
  }
  const command = args.shift();
  const options = {};
  const positionals = [];
  while (args.length > 0) {
    const token = args.shift();
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = args[0];
      if (!next || next.startsWith("--")) {
        options[key] = true;
        continue;
      }
      options[key] = args.shift();
      continue;
    }
    positionals.push(token);
  }
  return {
    command,
    options,
    positionals,
    json: jsonFlagIndex >= 0
  };
}

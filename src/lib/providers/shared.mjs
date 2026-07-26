export function escapeTomlMultiline(value) {
  return value.replace(/"""/g, '\\"""');
}

export function renderBody(role) {
  return [
    role.mission,
    "",
    "Operating rules:",
    ...role.rules.map((rule) => `- ${rule}`),
    "",
    "Report contract:",
    ...role.reportContract.map((rule) => `- ${rule}`)
  ].join("\n");
}

export function parseFrontmatter(markdown) {
  const lines = markdown.trim().split("\n");
  const data = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      break;
    }
    const [key, ...rest] = lines[index].split(":");
    data[key.trim()] = rest.join(":").trim();
  }
  return {
    frontmatter: data,
    body: lines.slice(index + 1).join("\n").trim()
  };
}

export function parseTomlRole(toml) {
  const data = {};
  const lines = toml.trim().split("\n");
  let body = "";
  let collecting = false;
  for (const line of lines) {
    if (line.startsWith("instructions =")) {
      collecting = true;
      continue;
    }
    if (collecting) {
      if (line === '"""') {
        collecting = false;
        continue;
      }
      body += `${body ? "\n" : ""}${line}`;
      continue;
    }
    const match = line.match(/^([a-z_]+)\s*=\s*"?(.*?)"?$/);
    if (match) {
      data[match[1]] = match[2];
    }
  }
  return { frontmatter: data, body };
}

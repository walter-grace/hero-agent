// Shell + file tools, bound to an executor (local temp dir or a Docker container). These turn
// hero-agent into a coding agent: it can run commands, read files, and write files in its sandbox.
// The benchmark runner hands each task a fresh executor so tasks stay isolated.
export function shellTools(executor) {
  return [
    {
      def: { type: "function", function: {
        name: "shell",
        description: "Run a shell command in the working directory and return stdout, stderr, and exit code. Use it to run code, tests, and inspect files.",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      } },
      async run({ cmd }) {
        const r = await executor.exec(String(cmd || ""));
        return `exit ${r.code}\n--- stdout ---\n${(r.stdout || "").slice(0, 4000)}\n--- stderr ---\n${(r.stderr || "").slice(0, 2000)}`;
      },
    },
    {
      def: { type: "function", function: {
        name: "write_file",
        description: "Write (or overwrite) a file with the given content, relative to the working directory.",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      } },
      async run({ path, content }) { await executor.write(String(path), String(content ?? "")); return `wrote ${path} (${String(content ?? "").length} bytes)`; },
    },
    {
      def: { type: "function", function: {
        name: "read_file",
        description: "Read a file relative to the working directory.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      } },
      async run({ path }) { return (await executor.read(String(path))).slice(0, 6000); },
    },
  ];
}

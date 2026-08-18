const fs = require("fs/promises");
const path = require("path");
const { exec } = require("child_process");

const {
  memorySearch,
  memoryGet,
  memorySave,
  memoryUpdate
} = require("./memory");

const WORKSPACE = path.resolve(
  process.env.WORKSPACE || "/app/workspace"
);

function safePath(relativePath = ".") {
  const target = path.resolve(WORKSPACE, relativePath);

  if (
    target !== WORKSPACE &&
    !target.startsWith(WORKSPACE + path.sep)
  ) {
    throw new Error("Path escapes workspace");
  }

  return target;
}

async function terminal(command) {
  return await new Promise((resolve) => {
    exec(
      command,
      {
        cwd: WORKSPACE,
        shell: "/bin/sh",
        timeout: Number(
          process.env.TERMINAL_TIMEOUT_MS || 30000
        ),
        maxBuffer: 2 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        resolve(
          JSON.stringify({
            exitCode: error?.code ?? 0,
            stdout: String(stdout).slice(0, 15000),
            stderr: String(stderr).slice(0, 15000)
          })
        );
      }
    );
  });
}

async function listFiles(filePath = ".") {
  const target = safePath(filePath);

  const entries = await fs.readdir(target, {
    withFileTypes: true
  });

  return entries
    .map(
      e =>
        `${e.isDirectory() ? "DIR " : "FILE"} ${e.name}`
    )
    .join("\n");
}

async function readFile(filePath) {
  const target = safePath(filePath);

  return (
    await fs.readFile(target, "utf8")
  ).slice(0, 30000);
}

async function writeFile(filePath, content) {
  const target = safePath(filePath);

  await fs.mkdir(path.dirname(target), {
    recursive: true
  });

  await fs.writeFile(target, content, "utf8");

  return `Wrote ${filePath}`;
}

const schemas = [
  {
    type: "function",
    function: {
      name: "terminal",
      description:
        "Run a shell command in the Railway workspace container.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string"
          }
        },
        required: ["command"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and directories in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string"
          }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string"
          }
        },
        required: ["path"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a UTF-8 file into the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string"
          },
          content: {
            type: "string"
          }
        },
        required: ["path", "content"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Search persistent Supabase memory.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string"
          },
          scope: {
            type: "string"
          },
          limit: {
            type: "integer"
          }
        },
        required: ["query"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "memory_get",
      description:
        "Get a specific persistent memory entry.",
      parameters: {
        type: "object",
        properties: {
          memory_key: {
            type: "string"
          },
          scope: {
            type: "string"
          }
        },
        required: ["memory_key"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "memory_save",
      description:
        "Save durable project knowledge to persistent memory.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string"
          },
          memory_key: {
            type: "string"
          },
          content: {
            type: "string"
          },
          importance: {
            type: "integer"
          },
          tags: {
            type: "array",
            items: {
              type: "string"
            }
          }
        },
        required: [
          "memory_key",
          "content"
        ]
      }
    }
  }
];

async function executeTool(name, args) {
  switch (name) {
    case "terminal":
      return terminal(args.command);

    case "list_files":
      return listFiles(args.path || ".");

    case "read_file":
      return readFile(args.path);

    case "write_file":
      return writeFile(
        args.path,
        args.content
      );

    case "memory_search":
      return JSON.stringify(
        await memorySearch(
          args.query,
          args.scope || "global",
          args.limit || 10
        )
      );

    case "memory_get":
      return JSON.stringify(
        await memoryGet(
          args.memory_key,
          args.scope || "global"
        )
      );

    case "memory_save":
      return JSON.stringify(
        await memorySave({
          scope: args.scope || "global",
          memory_key: args.memory_key,
          content: args.content,
          importance: args.importance || 5,
          tags: args.tags || []
        })
      );

    default:
      throw new Error(
        `Unknown tool: ${name}`
      );
  }
}

module.exports = {
  schemas,
  executeTool
};
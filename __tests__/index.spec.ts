import { spawn } from "node:child_process";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, describe, expect, it } from "vitest";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("Failed to acquire a free port"));
      }
    });
    srv.on("error", reject);
  });
}

function spawnAsync(
  command: string,
  args: string[],
  readyPattern?: RegExp,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let settled = false;

    const cleanup = () => {
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const onData = (data: Buffer) => {
      const text = data.toString();
      if (readyPattern?.test(text) && !settled) {
        settled = true;
        cleanup();
        clearTimeout(timer);
        resolve(child);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        cleanup();
        clearTimeout(timer);
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(child);
      }
    }, 5000);
  });
}

function killAsync(child: any): Promise<void> {
  return new Promise((resolve) => {
    child.on("exit", () => {
      resolve();
    });
    child.kill();
  });
}

describe("MCP Mermaid Server", () => {
  it("stdio", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: ["./build/index.js"],
    });
    const client = new Client({
      name: "stdio-client",
      version: "1.0.0",
    });
    await client.connect(transport);
    const listTools = await client.listTools();

    expect(listTools.tools.length).toBe(1);
    expect(listTools.tools[0].name).toBe("generate_mermaid_diagram");

    const mermaidCode = `flowchart TD
  A[Start] --> B[Process]
  B --> C[End]`;

    const res = await client.callTool({
      name: "generate_mermaid_diagram",
      arguments: {
        mermaid: mermaidCode,
        theme: "default",
        backgroundColor: "white",
        outputType: "svg_url",
      },
    });

    // @ts-expect-error ignore
    expect(res.content[0].text).toContain("https://mermaid.ink/svg/pako:");
  }, 30000);

  it("sse", async () => {
    const port = await getFreePort();
    const child = await spawnAsync(
      "node",
      ["./build/index.js", "-t", "sse", "-p", String(port)],
      /SSE Server listening on/,
    );

    // Wait longer for server to fully start
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const url = `http://localhost:${port}/sse`;
    const transport = new SSEClientTransport(new URL(url), {});

    const client = new Client(
      { name: "sse-client", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const listTools = await client.listTools();

      expect(listTools.tools.length).toBe(1);
      expect(listTools.tools[0].name).toBe("generate_mermaid_diagram");

      const mermaidCode = `sequenceDiagram
  Alice->>John: Hello John
  John-->>Alice: Hi Alice`;

      const res = await client.callTool({
        name: "generate_mermaid_diagram",
        arguments: {
          mermaid: mermaidCode,
          theme: "dark",
          outputType: "png_url",
        },
      });

      // @ts-expect-error ignore
      expect(res.content[0].text).toContain("https://mermaid.ink/img/pako:");
    } finally {
      await killAsync(child);
    }
  }, 30000);

  // TODO: Fix streamable test - currently timing out
  // it("streamable", async () => {
  //   const child = await spawnAsync("node", [
  //     "./build/index.js",
  //     "-t",
  //     "streamable",
  //     "-p",
  //     "1122",
  //   ]);

  //   // Wait longer for server to start
  //   await new Promise((resolve) => setTimeout(resolve, 2000));

  //   const url = "http://localhost:1122/mcp";
  //   const transport = new StreamableHTTPClientTransport(new URL(url));
  //   const client = new Client({
  //     name: "streamable-http-client",
  //     version: "1.0.0",
  //   });
  //   await client.connect(transport);
  //   const listTools = await client.listTools();

  //   expect(listTools.tools.length).toBe(1);
  //   expect(listTools.tools[0].name).toBe("generate_mermaid_diagram");

  //   const mermaidCode = `classDiagram
  // Animal <|-- Duck
  // Animal <|-- Fish
  // Animal: +int age`;

  //   const res = await client.callTool({
  //     name: "generate_mermaid_diagram",
  //     arguments: {
  //       mermaid: mermaidCode,
  //       theme: "forest",
  //       backgroundColor: "transparent",
  //       outputType: "svg_url",
  //     },
  //   });

  //   // @ts-expect-error ignore
  //   expect(res.content[0].text).toContain("https://mermaid.ink/svg/pako:");

  //   await killAsync(child);
  // }, 60000);
});

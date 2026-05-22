#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "ssh2";

// Router configurations
const ROUTERS = {
  vr: {
    host: "vr.redsi.co",
    port: 22,
    username: process.env.MIKROTIK_USER || "admin",
    privateKey: process.env.SSH_PRIVATE_KEY,
    password: process.env.MIKROTIK_PASSWORD,
  },
  sama: {
    host: "sama.redsi.co",
    port: 22,
    username: process.env.MIKROTIK_USER || "admin",
    privateKey: process.env.SSH_PRIVATE_KEY,
    password: process.env.MIKROTIK_PASSWORD,
  },
};

// Execute SSH command on a router
async function sshExec(routerName, command) {
  const config = ROUTERS[routerName];
  if (!config) {
    throw new Error(`Unknown router: ${routerName}. Available: ${Object.keys(ROUTERS).join(", ")}`);
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = "";
    let errorOutput = "";

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          reject(err);
          return;
        }

        stream.on("close", (code) => {
          conn.end();
          resolve({
            stdout: output,
            stderr: errorOutput,
            exitCode: code,
          });
        });

        stream.on("data", (data) => {
          output += data.toString();
        });

        stream.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });
      });
    });

    conn.on("error", (err) => {
      reject(err);
    });

    const connectionConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: 30000,
    };

    // Prefer private key, fall back to password
    if (config.privateKey) {
      connectionConfig.privateKey = config.privateKey;
    } else if (config.password) {
      connectionConfig.password = config.password;
    } else {
      // Try SSH agent
      connectionConfig.agent = process.env.SSH_AUTH_SOCK;
    }

    conn.connect(connectionConfig);
  });
}

// Create MCP server
const server = new Server(
  {
    name: "mikrotik-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "mikrotik_exec",
        description: "Execute a command on a MikroTik router via SSH. Available routers: vr (vr.redsi.co), sama (sama.redsi.co)",
        inputSchema: {
          type: "object",
          properties: {
            router: {
              type: "string",
              description: "Router name: 'vr' or 'sama'",
              enum: ["vr", "sama"],
            },
            command: {
              type: "string",
              description: "MikroTik RouterOS command to execute",
            },
          },
          required: ["router", "command"],
        },
      },
      {
        name: "mikrotik_wg_status",
        description: "Get WireGuard interface status from a MikroTik router",
        inputSchema: {
          type: "object",
          properties: {
            router: {
              type: "string",
              description: "Router name: 'vr' or 'sama'",
              enum: ["vr", "sama"],
            },
          },
          required: ["router"],
        },
      },
      {
        name: "mikrotik_wg_peers",
        description: "Get WireGuard peers configuration from a MikroTik router",
        inputSchema: {
          type: "object",
          properties: {
            router: {
              type: "string",
              description: "Router name: 'vr' or 'sama'",
              enum: ["vr", "sama"],
            },
          },
          required: ["router"],
        },
      },
      {
        name: "mikrotik_ping",
        description: "Ping from a MikroTik router to a destination",
        inputSchema: {
          type: "object",
          properties: {
            router: {
              type: "string",
              description: "Router name: 'vr' or 'sama'",
              enum: ["vr", "sama"],
            },
            address: {
              type: "string",
              description: "IP address or hostname to ping",
            },
            count: {
              type: "number",
              description: "Number of pings (default: 4)",
              default: 4,
            },
            interface: {
              type: "string",
              description: "Source interface (optional)",
            },
          },
          required: ["router", "address"],
        },
      },
      {
        name: "mikrotik_routes",
        description: "Get routing table from a MikroTik router",
        inputSchema: {
          type: "object",
          properties: {
            router: {
              type: "string",
              description: "Router name: 'vr' or 'sama'",
              enum: ["vr", "sama"],
            },
            filter: {
              type: "string",
              description: "Optional filter (e.g., 'where gateway=10.0.0.1')",
            },
          },
          required: ["router"],
        },
      },
      {
        name: "mikrotik_firewall",
        description: "Get firewall filter rules from a MikroTik router",
        inputSchema: {
          type: "object",
          properties: {
            router: {
              type: "string",
              description: "Router name: 'vr' or 'sama'",
              enum: ["vr", "sama"],
            },
          },
          required: ["router"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "mikrotik_exec": {
        const result = await sshExec(args.router, args.command);
        return {
          content: [
            {
              type: "text",
              text: `Router: ${args.router}\nCommand: ${args.command}\n\nOutput:\n${result.stdout}${result.stderr ? `\nErrors:\n${result.stderr}` : ""}`,
            },
          ],
        };
      }

      case "mikrotik_wg_status": {
        const result = await sshExec(args.router, "/interface/wireguard/print detail");
        return {
          content: [
            {
              type: "text",
              text: `WireGuard Interfaces on ${args.router}:\n\n${result.stdout}`,
            },
          ],
        };
      }

      case "mikrotik_wg_peers": {
        const result = await sshExec(args.router, "/interface/wireguard/peers/print detail");
        return {
          content: [
            {
              type: "text",
              text: `WireGuard Peers on ${args.router}:\n\n${result.stdout}`,
            },
          ],
        };
      }

      case "mikrotik_ping": {
        const count = args.count || 4;
        let cmd = `/ping address=${args.address} count=${count}`;
        if (args.interface) {
          cmd += ` interface=${args.interface}`;
        }
        const result = await sshExec(args.router, cmd);
        return {
          content: [
            {
              type: "text",
              text: `Ping from ${args.router} to ${args.address}:\n\n${result.stdout}`,
            },
          ],
        };
      }

      case "mikrotik_routes": {
        let cmd = "/ip/route/print detail";
        if (args.filter) {
          cmd += ` ${args.filter}`;
        }
        const result = await sshExec(args.router, cmd);
        return {
          content: [
            {
              type: "text",
              text: `Routing Table on ${args.router}:\n\n${result.stdout}`,
            },
          ],
        };
      }

      case "mikrotik_firewall": {
        const result = await sshExec(args.router, "/ip/firewall/filter/print");
        return {
          content: [
            {
              type: "text",
              text: `Firewall Rules on ${args.router}:\n\n${result.stdout}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MikroTik MCP Server running on stdio");
}

main().catch(console.error);

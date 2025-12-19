import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const MCP_PATH = "/mcp";
const port = Number(process.env.PORT ?? 8787);

const widgetHtml = readFileSync("public/widget.html", "utf8");

/**
 * Serve any GET file under /public (needed for domain verification: /.well-known/openai)
 * Example:
 *   URL:  /.well-known/openai
 *   File: public/.well-known/openai
 */
function tryServePublicFile(urlPathname, res) {
  // decode and normalize to prevent path traversal
  const decoded = decodeURIComponent(urlPathname);
  const safe = path.posix.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(process.cwd(), "public", safe);

  if (!existsSync(filePath)) return false;

  const isHtml = filePath.endsWith(".html");
  res.writeHead(200, {
    "content-type": isHtml
      ? "text/html; charset=utf-8"
      : "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(readFileSync(filePath));
  return true;
}

function normalizeLines(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function buildSowDoc(input) {
  const projectName = normalizeLines(input.project_name);
  const client = normalizeLines(input.client);
  const goal = normalizeLines(input.goal);
  const deliverables = normalizeLines(input.deliverables);
  const timelineWeeks = input.timeline_weeks ?? null;
  const constraints = normalizeLines(input.constraints);

  const title = `Statement of Work (SOW) — ${projectName || "Project"}`;

  const sections = [];

  sections.push({
    heading: "1. Overview",
    body: [
      client ? `Client: ${client}` : null,
      `Project: ${projectName || "—"}`,
      `Goal: ${goal || "—"}`
    ]
      .filter(Boolean)
      .join("\n")
  });

  sections.push({
    heading: "2. Scope",
    body: deliverables
      ? `Deliverables (what will be produced):\n- ${deliverables
          .split("\n")
          .filter(Boolean)
          .join("\n- ")}`
      : "Deliverables: —"
  });

  sections.push({
    heading: "3. Out of Scope",
    body:
      "Unless explicitly added in writing, the following are out of scope:\n" +
      "- Ongoing maintenance / support beyond handoff\n" +
      "- Work not described in the Deliverables section\n" +
      "- Additional revision rounds beyond what is agreed"
  });

  sections.push({
    heading: "4. Milestones",
    body:
      (timelineWeeks
        ? `Target timeline: ~${timelineWeeks} week(s)\n`
        : "Target timeline: To be agreed\n") +
      "Suggested milestones:\n" +
      "- Kickoff & requirements alignment\n" +
      "- Draft / first delivery\n" +
      "- Review & revisions\n" +
      "- Final delivery & handoff"
  });

  sections.push({
    heading: "5. Acceptance Criteria",
    body:
      "- Deliverables match the written scope and agreed format\n" +
      "- Final files/outputs provided and accessible\n" +
      "- Review feedback incorporated within the agreed revision policy\n" +
      "- Client sign-off provided in writing"
  });

  sections.push({
    heading: "6. Assumptions & Dependencies",
    body:
      "- Client provides required inputs (content, access, brand assets) on time\n" +
      "- Single point of contact for approvals\n" +
      "- Delays in feedback may shift timeline"
  });

  sections.push({
    heading: "7. Risks",
    body:
      "- Scope expansion without change control\n" +
      "- Delayed inputs/approvals\n" +
      "- Conflicting stakeholder feedback"
  });

  if (constraints) {
    sections.push({
      heading: "8. Constraints / Notes",
      body: constraints
    });
  }

  const markdown = `# ${title}

${sections.map((s) => `## ${s.heading}\n\n${s.body}\n`).join("\n")}
`;

  return { title, sections, markdown };
}

function createScopeSowServer() {
  const server = new McpServer({ name: "scope-to-sow", version: "0.1.0" });

  // Widget resource
  server.registerResource(
    "scope-sow-widget",
    "ui://widget/scope-sow.html",
    {},
    async () => ({
      contents: [
        {
          uri: "ui://widget/scope-sow.html",
          mimeType: "text/html+skybridge",
          text: widgetHtml,
          _meta: {
            "openai/widgetPrefersBorder": true,
            "openai/widgetDescription":
              "Fill a few fields to generate a client-ready Statement of Work (SOW).",
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: ["https://*.oaistatic.com"]
            }
          }
        }
      ]
    })
  );

  // Open widget tool
  server.registerTool(
    "open_sow_builder",
    {
      title: "Open SOW Builder",
      description: "Opens the interactive SOW Builder widget.",
      inputSchema: {},
      _meta: {
        "openai/outputTemplate": "ui://widget/scope-sow.html",
        "openai/toolInvocation/invoking": "Opening SOW Builder…",
        "openai/toolInvocation/invoked": "SOW Builder ready."
      }
    },
    async () => ({
      content: [{ type: "text", text: "SOW Builder opened." }],
      structuredContent: { ready: true, title: null, sections: [], markdown: "" },
      _meta: {}
    })
  );

  // Generate SOW tool
  const generateInputSchema = {
    project_name: z.string().min(1),
    client: z.string().optional(),
    goal: z.string().min(1),
    deliverables: z.string().min(1),
    timeline_weeks: z.number().int().min(1).max(104).optional(),
    constraints: z.string().optional()
  };

  server.registerTool(
    "generate_sow",
    {
      title: "Generate SOW",
      description: "Generates a client-ready SOW from structured inputs.",
      inputSchema: generateInputSchema,
      _meta: {
        "openai/outputTemplate": "ui://widget/scope-sow.html",
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Generating SOW…",
        "openai/toolInvocation/invoked": "SOW generated."
      }
    },
    async (args) => {
      const doc = buildSowDoc(args ?? {});
      return {
        content: [{ type: "text", text: `Generated: ${doc.title}` }],
        structuredContent: doc,
        _meta: { generated_at: new Date().toISOString() }
      };
    }
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const isMcpRoute = url.pathname === MCP_PATH || url.pathname === `${MCP_PATH}/`;

  // 1) Serve static files under /public for ANY GET path except "/" and MCP
  if (req.method === "GET" && url.pathname !== "/" && !isMcpRoute) {
    const served = tryServePublicFile(url.pathname, res);
    if (served) return;
  }

  // 2) Health check
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Scope-to-SOW MCP server");
    return;
  }

  // 3) MCP endpoint
  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (isMcpRoute && req.method && MCP_METHODS.has(req.method)) {
    const server = createScopeSowServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`Scope-to-SOW MCP server listening on http://localhost:${port}${MCP_PATH}`);
});

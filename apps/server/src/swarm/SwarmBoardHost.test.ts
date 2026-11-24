// @effect-diagnostics nodeBuiltinImport:off -- tests exercise real filesystem discovery and temp sidecar modules.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  dispatchSwarmBoardRequest,
  findSwarmBoardDirectory,
  readSwarmMemberTranscript,
  resolveSwarmAppDataDirectory,
  rewriteSwarmBoardHiveJs,
  rewriteSwarmBoardIndexHtml,
} from "./SwarmBoardHost.ts";

describe("SwarmBoardHost", () => {
  it("rewrites root-relative asset links in index.html and hive.js", () => {
    const html = [
      '<script src="/preload.js"></script>',
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2">',
      '<script src="//cdn.example/a.js"></script>',
      '<script src="/app.js"></script>',
    ].join("\n");

    const rewritten = rewriteSwarmBoardIndexHtml(html);
    expect(rewritten).toContain('src="./preload.js"');
    expect(rewritten).toContain('href="./styles.css"');
    expect(rewritten).toContain('href="https://fonts.googleapis.com/css2"');
    expect(rewritten).toContain('src="//cdn.example/a.js"');
    expect(rewritten).toContain('src="./app.js"');

    const hive = "const u = `/api/frame?conversationId=${conv}&path=${p}`;";
    expect(rewriteSwarmBoardHiveJs(hive)).toBe(
      "const u = `./api/frame?conversationId=${conv}&path=${p}`;",
    );
  });

  it("loads a sidecar_sdk swarm_board module and dispatches page, static, preload, and data routes", async () => {
    const tempRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-swarm-host-"));
    try {
      const appDataDir = NodePath.join(
        tempRoot,
        "providers",
        "antigravity",
        "p1",
        "antigravity-acp",
      );
      const swarmBoardDir = NodePath.join(
        appDataDir,
        "builtin",
        "plugins",
        "swarm",
        "sidecars",
        "swarm_board",
      );
      await NodeFSP.mkdir(swarmBoardDir, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(swarmBoardDir, "main.mjs"),
        `import { SidecarApp, Response } from "sidecar_sdk";
const app = new SidecarApp();
app.page("/", () => '<script src="/preload.js"></script><script src="/hive.js"></script>');
app.api("/hive.js", () => new Response("const x = \`/api/frame?a=1\`;", { contentType: "application/javascript" }), "GET");
app.api("/api/swarm", (data) => ({
  conversationId: data.conversationId,
  dataDir: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
  overview: process.env.SWARM_OVERVIEW ?? "unset",
  swarm: data.conversationId ? "swarm-1" : null,
}), "GET");
app.run();
`,
      );

      const discovered = await findSwarmBoardDirectory(tempRoot, null);
      expect(discovered).toBe(swarmBoardDir);

      const page = await dispatchSwarmBoardRequest({
        swarmBoardDir,
        appDataDir,
        conversationId: "conv-12345678",
        routePath: "/",
        searchParams: new URLSearchParams(),
      });
      expect(page.status).toBe(200);
      expect(page.contentType).toContain("text/html");
      expect(page.body).toContain('src="./preload.js"');
      expect(page.body).toContain('src="./hive.js"');

      const preload = await dispatchSwarmBoardRequest({
        swarmBoardDir,
        appDataDir,
        conversationId: "conv-12345678",
        routePath: "/preload.js",
        searchParams: new URLSearchParams(),
      });
      expect(preload.status).toBe(200);
      expect(preload.contentType).toContain("javascript");
      expect(String(preload.body)).toContain("window.sidecar");

      const hive = await dispatchSwarmBoardRequest({
        swarmBoardDir,
        appDataDir,
        conversationId: "conv-12345678",
        routePath: "/hive.js",
        searchParams: new URLSearchParams(),
      });
      expect(hive.status).toBe(200);
      expect(hive.body).toBe("const x = `./api/frame?a=1`;");

      // Server-bound conversationId must override any caller-supplied query param.
      const api = await dispatchSwarmBoardRequest({
        swarmBoardDir,
        appDataDir,
        conversationId: "conv-12345678",
        routePath: "/api/swarm",
        searchParams: new URLSearchParams({ conversationId: "spoofed-id" }),
      });
      expect(api.status).toBe(200);
      const parsed = JSON.parse(String(api.body)) as {
        conversationId: string;
        dataDir: string;
        swarm: string;
      };
      expect(parsed.conversationId).toBe("conv-12345678");
      expect(parsed.swarm).toBe("swarm-1");
      expect(parsed.dataDir).toBe(
        NodePath.join(appDataDir, "sidecar_data", "swarm", "swarm_board", "data"),
      );

      // Thread with no Antigravity conversation returns an empty swarm payload.
      const empty = await dispatchSwarmBoardRequest({
        swarmBoardDir,
        appDataDir: null,
        conversationId: null,
        routePath: "/api/swarm",
        searchParams: new URLSearchParams(),
      });
      expect(empty.status).toBe(200);
      expect(JSON.parse(String(empty.body))).toEqual({
        conversationId: null,
        swarm: null,
        member: null,
      });
    } finally {
      await NodeFSP.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reads a swarm member transcript and blocks conversations outside the roster", async () => {
    const tempRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-swarm-transcript-"));
    try {
      const coordId = "11111111-1111-1111-1111-111111111111";
      const workerId = "22222222-2222-2222-2222-222222222222";
      const outsiderId = "99999999-9999-9999-9999-999999999999";

      const swarmDir = NodePath.join(tempRoot, "brain", coordId, ".system_generated", "swarm");
      const workerLogs = NodePath.join(tempRoot, "brain", workerId, ".system_generated", "logs");
      const outsiderLogs = NodePath.join(
        tempRoot,
        "brain",
        outsiderId,
        ".system_generated",
        "logs",
      );
      await NodeFSP.mkdir(swarmDir, { recursive: true });
      await NodeFSP.mkdir(workerLogs, { recursive: true });
      await NodeFSP.mkdir(outsiderLogs, { recursive: true });

      await NodeFSP.writeFile(
        NodePath.join(swarmDir, "members.json"),
        JSON.stringify({
          title: "PR Swarm",
          members: {
            coordinator: { conversation_id: coordId, role: "coordinator", model: "gemini-4-neon" },
            "backend-pr": {
              conversation_id: workerId,
              role: "worker",
              model: "gemini-4-neon",
              killed: true,
            },
          },
        }),
      );
      await NodeFSP.writeFile(
        NodePath.join(workerLogs, "transcript_full.jsonl"),
        [
          JSON.stringify({
            step_index: 0,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            status: "DONE",
            model: "gemini-4-neon-high",
            thinking: "Checking git status",
            tool_calls: [{ name: "run_command", args: { CommandLine: "git status" } }],
          }),
          JSON.stringify({
            step_index: 1,
            source: "MODEL",
            type: "GENERIC",
            status: "ERROR",
            error: "permission check failed",
          }),
        ].join("\n") + "\n",
      );
      await NodeFSP.writeFile(
        NodePath.join(outsiderLogs, "transcript_full.jsonl"),
        JSON.stringify({ step_index: 0, content: "secret" }) + "\n",
      );

      const transcript = await readSwarmMemberTranscript({
        appDataDir: tempRoot,
        threadConversationId: coordId,
        targetConversationId: workerId,
      });
      expect(transcript).not.toBeNull();
      expect(transcript?.member.name).toBe("backend-pr");
      expect(transcript?.member.killed).toBe(true);
      expect(transcript?.steps).toHaveLength(2);
      expect(transcript?.steps[0]?.toolCalls[0]?.name).toBe("run_command");
      expect(transcript?.steps[1]?.error).toBe("permission check failed");

      const denied = await readSwarmMemberTranscript({
        appDataDir: tempRoot,
        threadConversationId: coordId,
        targetConversationId: outsiderId,
      });
      expect(denied).toBeNull();
    } finally {
      await NodeFSP.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back read-only to another providers root when a seeded dev thread's brain lives there", async () => {
    const tempRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-swarm-fallback-"));
    try {
      const devStateDir = NodePath.join(tempRoot, "dev");
      const prodProvidersRoot = NodePath.join(tempRoot, "userdata", "providers", "antigravity");
      const convId = "33333333-3333-3333-3333-333333333333";
      const primaryAppDataDir = NodePath.join(
        devStateDir,
        "providers",
        "antigravity",
        "hash-a",
        "antigravity-acp",
      );
      const fallbackAppDataDir = NodePath.join(prodProvidersRoot, "hash-a", "antigravity-acp");
      await NodeFSP.mkdir(NodePath.join(fallbackAppDataDir, "brain", convId), { recursive: true });

      const resolved = await resolveSwarmAppDataDirectory({
        stateDir: devStateDir,
        primaryAppDataDir,
        conversationId: convId,
        fallbackProvidersRoot: prodProvidersRoot,
      });
      expect(resolved).toBe(fallbackAppDataDir);
    } finally {
      await NodeFSP.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to compact transcript.jsonl when transcript_full.jsonl ends with a >2 MiB line and resolves worker threads", async () => {
    const tempRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-swarm-oversize-"));
    try {
      const coordId = "44444444-4444-4444-4444-444444444444";
      const workerId = "55555555-5555-5555-5555-555555555555";
      const swarmDir = NodePath.join(tempRoot, "brain", coordId, ".system_generated", "swarm");
      const workerLogs = NodePath.join(tempRoot, "brain", workerId, ".system_generated", "logs");
      await NodeFSP.mkdir(swarmDir, { recursive: true });
      await NodeFSP.mkdir(workerLogs, { recursive: true });

      await NodeFSP.writeFile(
        NodePath.join(swarmDir, "members.json"),
        JSON.stringify({
          title: "Oversize Swarm",
          members: {
            coordinator: { conversation_id: coordId, role: "coordinator", model: "gemini-4-neon" },
            "big-worker": { conversation_id: workerId, role: "worker", model: "gemini-4-neon" },
          },
        }),
      );
      // Single >2 MiB line without trailing newline leaves an empty tail in transcript_full.jsonl.
      const hugeLine = JSON.stringify({ step_index: 0, content: "x".repeat(2_200_000) });
      await NodeFSP.writeFile(NodePath.join(workerLogs, "transcript_full.jsonl"), hugeLine);
      await NodeFSP.writeFile(
        NodePath.join(workerLogs, "transcript.jsonl"),
        JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", content: "compact fallback" }) +
          "\n",
      );

      // Resolve via worker's own conversationId (exercises brain roster scan + case-insensitive match).
      const transcript = await readSwarmMemberTranscript({
        appDataDir: tempRoot,
        threadConversationId: workerId.toUpperCase(),
        targetConversationId: workerId,
      });
      expect(transcript).not.toBeNull();
      expect(transcript?.member.name).toBe("big-worker");
      expect(transcript?.steps).toHaveLength(1);
      expect(transcript?.steps[0]?.content).toBe("compact fallback");
    } finally {
      await NodeFSP.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync, createReadStream, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDGET_URI = "ui://rvc-voice/player-v1.html";
const WIDGET_HTML = readFileSync(path.join(ROOT_DIR, "public", "widget.html"), "utf8");
const PORT = Number(process.env.PORT ?? "8788");
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const HTTP_TOKEN = process.env.HTTP_TOKEN?.trim() ?? "";
const LOCAL_DIR = path.join(ROOT_DIR, "local");
const LOCAL_APPLIO_DIR = path.join(LOCAL_DIR, "Applio");
const LOCAL_MODELS_DIR = path.join(LOCAL_DIR, "models");

function envValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function findFiles(directory: string, extension: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

const modelCandidates = findFiles(LOCAL_MODELS_DIR, ".pth");
const indexCandidates = findFiles(LOCAL_MODELS_DIR, ".index");
const configuredApplioDir = envValue("APPLIO_DIR");
const configuredPythonPath = envValue("PYTHON_PATH");
const configuredModelPath = envValue("RVC_MODEL_PATH");
const configuredIndexPath = envValue("RVC_INDEX_PATH");
const APPLIO_DIR = configuredApplioDir || LOCAL_APPLIO_DIR;
const PYTHON_PATH = configuredPythonPath || path.join(APPLIO_DIR, "env", "python.exe");
const MODEL_PATH = configuredModelPath || (modelCandidates.length === 1 ? modelCandidates[0] : "");
const INDEX_PATH = configuredIndexPath || (indexCandidates.length === 1 ? indexCandidates[0] : "");
const OUTPUT_DIR = envValue("OUTPUT_DIR") || path.join(ROOT_DIR, "output");
const TTS_VOICE = process.env.TTS_VOICE ?? "zh-CN-YunxiNeural";
const MAX_TEXT_LENGTH = Number(process.env.MAX_TEXT_LENGTH ?? "1200");

mkdirSync(OUTPUT_DIR, { recursive: true });
const audioFiles = new Map<string, string>();
let generationQueue: Promise<unknown> = Promise.resolve();

function assertConfigured(): void {
  for (const [label, value] of [["Applio Python", PYTHON_PATH], ["RVC model", MODEL_PATH], ["RVC index", INDEX_PATH]]) {
    if (!value || !existsSync(value)) throw new Error(`${label} not found: ${value || "not configured"}`);
  }
}

function runApplioTts(text: string, outputPath: string): Promise<void> {
  assertConfigured();
  const ttsPath = path.join(OUTPUT_DIR, `${path.parse(outputPath).name}-base.wav`);
  const args = ["core.py", "tts", "--tts-file", path.join(OUTPUT_DIR, "__no_tts_file__.txt"), "--tts-text", text, "--tts-voice", TTS_VOICE, "--tts-rate", "0",
    "--output-tts-path", ttsPath, "--output-rvc-path", outputPath, "--pth-path", MODEL_PATH,
    "--index-path", INDEX_PATH, "--pitch", "0", "--index-rate", "0.65", "--volume-envelope", "0.25",
    "--protect", "0.33", "--f0-method", "rmvpe", "--export-format", "WAV", "--embedder-model", "contentvec"];
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_PATH, args, { cwd: APPLIO_DIR, windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 && existsSync(outputPath)
      ? resolve() : reject(new Error(stderr.trim() || `Applio exited with code ${code}`)));
  });
}

function queueSpeech(text: string): Promise<{ id: string; audioUrl: string }> {
  const task = async () => {
    const id = randomUUID();
    const outputPath = path.join(OUTPUT_DIR, `${id}.wav`);
    await runApplioTts(text, outputPath);
    audioFiles.set(id, outputPath);
    const token = HTTP_TOKEN ? `?token=${encodeURIComponent(HTTP_TOKEN)}` : "";
    return { id, audioUrl: `${PUBLIC_BASE_URL}/audio/${id}.wav${token}` };
  };
  const result = generationQueue.then(task, task);
  generationQueue = result.catch(() => undefined);
  return result;
}

function createAppServer(): McpServer {
  const server = new McpServer({ name: "rvc-voice-mcp", version: "0.1.0" });
  registerAppResource(server, "rvc-player", WIDGET_URI, {}, async () => ({ contents: [{
    uri: WIDGET_URI, mimeType: RESOURCE_MIME_TYPE, text: WIDGET_HTML,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [PUBLIC_BASE_URL], resourceDomains: [PUBLIC_BASE_URL] } },
      "openai/widgetDescription": "An audio player for locally generated RVC speech, clearly labeled as AI-generated." },
  }] }));

  registerAppTool(server, "speak_rvc", {
    title: "Speak with an RVC voice",
    description: "Use this when the user asks to hear text spoken with the configured local RVC voice. The result is AI-generated audio.",
    inputSchema: { text: z.string().min(1).max(MAX_TEXT_LENGTH).describe("Text to synthesize and play.") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: { ui: { resourceUri: WIDGET_URI }, "openai/outputTemplate": WIDGET_URI,
      "openai/toolInvocation/invoking": "Generating RVC speech…", "openai/toolInvocation/invoked": "RVC speech is ready" },
  }, async ({ text }) => {
    const cleanText = text.trim();
    const { id, audioUrl } = await queueSpeech(cleanText);
    return { content: [{ type: "text" as const, text: "Generated an AI voice clip and opened the audio player." }],
      structuredContent: { id, text: cleanText, audioUrl, voice: TTS_VOICE, aiGenerated: true } };
  });

  registerAppTool(server, "get_status", {
    title: "Check RVC voice service",
    description: "Use this when the user asks whether the local RVC voice service is configured and ready.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {},
  }, async () => {
    const checks = { python: existsSync(PYTHON_PATH), model: existsSync(MODEL_PATH), index: existsSync(INDEX_PATH) };
    const ready = Object.values(checks).every(Boolean);
    return { content: [{ type: "text" as const, text: ready ? "RVC voice service is ready." : "RVC voice service needs configuration." }],
      structuredContent: { ready, checks, configuration: {
        applio: configuredApplioDir || configuredPythonPath ? "manual" : "automatic",
        model: configuredModelPath ? "manual" : "automatic",
        index: configuredIndexPath ? "manual" : "automatic",
        localModelCandidates: { pth: modelCandidates.length, index: indexCandidates.length },
      }, voice: TTS_VOICE, maxTextLength: MAX_TEXT_LENGTH } };
  });
  return server;
}

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!HTTP_TOKEN) return true;
  return req.headers.authorization?.replace(/^Bearer\s+/i, "") === HTTP_TOKEN || url.searchParams.get("token") === HTTP_TOKEN;
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

createServer(async (req, res) => {
  if (!req.url) return sendJson(res, 400, { error: "Missing URL" });
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const isMcp = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");
  if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, service: "rvc-voice-mcp" });
  if (!authorized(req, url)) return sendJson(res, 401, { error: "Unauthorized" });

  const audioMatch = /^\/audio\/([0-9a-f-]+)\.wav$/.exec(url.pathname);
  if (req.method === "GET" && audioMatch) {
    const filePath = audioFiles.get(audioMatch[1]);
    if (!filePath || !existsSync(filePath)) return sendJson(res, 404, { error: "Audio not found" });
    res.writeHead(200, { "content-type": "audio/wav", "cache-control": "private, max-age=3600" });
    createReadStream(filePath).pipe(res); return;
  }
  if (req.method === "OPTIONS" && isMcp) {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization", "Access-Control-Expose-Headers": "Mcp-Session-Id" }).end(); return;
  }
  if (isMcp && req.method && new Set(["GET", "POST", "DELETE"]).has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    const server = createAppServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch (error) { console.error(error); if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" }); }
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}).listen(PORT, "127.0.0.1", () => console.log(`RVC Voice MCP listening on http://127.0.0.1:${PORT}/mcp`));

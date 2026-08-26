# RVC Voice MCP

Turn text from an MCP-capable chat client into speech, convert it with a local RVC `.pth + .index` model, and render an audio player in the conversation.

> This project generates synthetic audio. Only use voices you own or have permission to use, and clearly disclose AI-generated output.

## How it works

1. ChatGPT calls `speak_rvc` with text.
2. The local server asks Applio to synthesize a base voice and run RVC conversion.
3. The MCP Apps widget renders the generated WAV in an inline player.

The server never accepts model paths or shell commands from chat. Paths are fixed in local environment configuration and excluded from Git.

## Requirements

- Windows and Node.js 20+
- A working local Applio installation
- An RVC inference `.pth` and matching `.index`
- ChatGPT Developer Mode and a public HTTPS tunnel for web integration

## Local setup

```powershell
Copy-Item .env.example .env
npm install
npm run check
npm start
```

Edit `.env` before starting and replace `HTTP_TOKEN` with a long random secret.

- Health: `http://127.0.0.1:8788/health`
- MCP: `http://127.0.0.1:8788/mcp?token=YOUR_TOKEN`

## One-click public endpoint

Run:

```powershell
npm run public
```

The first run downloads Cloudflare Tunnel into the ignored local `tools` folder. The script generates a fresh access token, starts the MCP server and tunnel in the background, then prints the HTTPS connector URL to add in ChatGPT Developer Mode. Keep that terminal open only while reading the URL; the two background processes continue running.

Stop both processes with:

```powershell
npm run stop
```

Quick tunnels are intended for development and their URL changes each time. For a stable public release, configure a named Cloudflare Tunnel and a domain you control.

## Tools

- `speak_rvc(text)` generates AI speech and renders the player.
- `get_status()` checks local configuration without exposing paths.

## Current scope

The initial adapter uses Applio's built-in TTS command and RVC inference. Fully offline TTS and a stable named tunnel are future work.

## License

MIT

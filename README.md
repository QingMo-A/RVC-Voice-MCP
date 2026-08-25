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

For ChatGPT web, expose port 8788 through a token-protected HTTPS tunnel, set `PUBLIC_BASE_URL` to that HTTPS origin, restart, enable Developer Mode, and register the HTTPS `/mcp` URL as a custom plugin/app.

## Tools

- `speak_rvc(text)` generates AI speech and renders the player.
- `get_status()` checks local configuration without exposing paths.

## Current scope

The initial adapter uses Applio's built-in TTS command and RVC inference. Fully offline TTS and automatic tunnel setup are planned.

## License

MIT

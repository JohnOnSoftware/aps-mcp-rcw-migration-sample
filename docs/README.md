# AU2026 MCP Workshop: Advanced

Welcome to the advanced session of the **Autodesk Platform Services MCP Workshop** at Autodesk University 2026.

## What you'll build

Starting from the small MCP server the [beginner session](https://github.com/autodesk-platform-services/au2026-mcp-workshop-beginner) produces, you'll turn it into a networked server that acts on behalf of a signed-in Autodesk user and renders 3D previews in chat:

- Replace the **STDIO** transport with **Streamable HTTP** over Express, so the server runs as a standalone web service on its own URL.
- Swap **2-legged** application authentication for **3-legged** user OAuth, and put an OAuth proxy of your own in front of `/mcp` so an MCP client has to sign in — with the same Autodesk account — before it can call a single tool.
- Add a `preview-design` MCP tool that returns an embedded **APS Viewer** panel, letting the AI show designs in 3D and read back what the user selects.
- Beyond the tutorial, the finished server also has folder tools (`list-folder-contents`, `create-folder`) and RCW migration tools (`check-migrator-setup`, `migrate-rcw-model`, `get-migration-status`, `cancel-migration`) with a progress panel. See the [RCW migration design doc](rcw-migration-implementation.md).

![Screenshot](screenshot.png)

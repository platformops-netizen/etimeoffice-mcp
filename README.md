# eTimeOffice attendance — MCP connector

Small, dependency-free Node 18+ server that exposes eTimeOffice (Team Office) cloud attendance to Claude as an MCP connector.

## Tool

`attendance` — `{from, to, emp?, kind?}`
- `kind: "inout"` (default): daily in/out per employee (`DownloadInOutPunchData`, dates `DD/MM/YYYY`)
- `kind: "punch"`: raw punches (`DownloadPunchData`, `DD/MM/YYYY_HH:MM`)
- `kind: "mcid"`: punches with machine id (`DownloadPunchDataMCID`)

## Deploy on Render

1. New → Web Service → connect this repo. Runtime **Node**, build command `npm install`, start command `npm start` (free instance is fine).
2. Environment variables:
   - `ETO_CORP` — INCNUTFCHYD
   - `ETO_USER` — INCNUTFCHYD
   - `ETO_PASS` — Magzine@123
   - `MCP_SECRET` — use Render's **Generate** button
3. Deploy. `https://<service>.onrender.com/health` should answer `{"ok":true,...}`.

## Add to Claude

Settings → Connectors → Add custom connector:
- Name: **eTimeOffice Attendance**
- URL: `https://<service>.onrender.com/mcp/<MCP_SECRET>`

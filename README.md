# IncNut Warehouse Attendance

A small, dependency-free Node 18+ server that:

- serves the **IncNut Warehouse Attendance** web page (no login): today's attendance from eTimeOffice with present/absent, in/out time, the time each person can leave (in-punch + 9 h), late-in and hours (green = 9 h or more, red = under 9 h), a Refresh button, previous/next day and search;
- optionally exposes the same attendance to Claude as an MCP connector (`attendance` tool).

## Deploy on Render

1. New → Web Service → connect this repo (or paste `https://github.com/platformops-netizen/etimeoffice-mcp`).
2. Name: `incnut-warehouse-attendance` (the web address becomes `https://incnut-warehouse-attendance.onrender.com`).
3. Runtime **Node**, build command `npm install`, start command `npm start`. Free instance type is fine.
4. Environment variables:
   - `ETO_CORP` — eTimeOffice Corporate ID
   - `ETO_USER` — eTimeOffice username
   - `ETO_PASS` — eTimeOffice password
   - `PAGE_KEY` — optional. Leave it out and the page is at the plain address. Set it (Render's **Generate** button) to keep the page private at `/att/<PAGE_KEY>`.
   - `MCP_SECRET` — optional, only if you also want the Claude connector at `/mcp/<MCP_SECRET>`.
5. Deploy. `https://incnut-warehouse-attendance.onrender.com/health` should answer `{"ok":true,...}`.

On the free plan the service sleeps when unused, so the first visit after a quiet spell can take up to a minute.

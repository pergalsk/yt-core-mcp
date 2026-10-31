# yt-core-mcp

MCP server for YouTube: live stream scheduling (title, description, date/time, thumbnail, publish) and channel management. TypeScript, official Google APIs only.

> Status: step 1 — project base, secure login, `auth_status` tool.

## Setup

1. **Google Cloud project** (one-time)
   - Create a project in [Google Cloud Console](https://console.cloud.google.com/).
   - *APIs & Services → Library*: enable **YouTube Data API v3** (and **YouTube Analytics API** if you want analytics).
   - *Google Auth Platform → Branding / Audience*: user type **External**, add the channel owner account as a test user.
     Then **Publish app → In production** — in *Testing* mode Google expires refresh tokens after 7 days.
   - *Clients → Create client → Application type: Desktop app*. Download the JSON.
   - Save it as `%APPDATA%\yt-core-mcp\client_secret.json` (or set `YT_CORE_MCP_CLIENT_FILE`).
2. **Build**: `npm ci && npm run build`
3. **Log in** (in a terminal, not through the AI): `node dist/bin.js auth`
   - add permissions later: `node dist/bin.js auth --add analytics` (groups: `captions`, `comments`, `analytics`)
   - `--status`, `--logout` (revokes the token at Google)
4. **Register in Claude Code**: `claude mcp add yt-core -- node D:/Projects/yt-core-mcp/dist/bin.js`
5. **Local files** (thumbnails, videos, captions): set `YT_CORE_MCP_MEDIA_ROOT` to the only folder the server may read (e.g. `D:\Media\YouTube`). Unset ⇒ file uploads are disabled.

## Security design

- **OAuth 2.0 for installed apps** (RFC 8252): authorization code + **PKCE S256** + random `state` (constant-time check), loopback redirect on **127.0.0.1 only**, random port, 2-min timeout, no request data reflected into HTML.
- **Login is CLI-only** — the MCP server cannot start a login or see tokens.
- **Least privilege**: only `youtube` scope by default; captions/comments/analytics added with incremental authorization.
- **Token storage**: refresh token in the OS vault (Windows Credential Manager via `@napi-rs/keyring`); access tokens only in memory. Logout revokes at Google.
- **Local file guard**: one allowed folder; realpath containment (no `..`, symlink, junction, hard link or UNC escape), regular files only, official size limits, magic-byte type check, read only from the checked handle, same refusal message for every case.
- **MCP**: stdio transport only, all logs to stderr, tool annotations (`readOnlyHint`, `destructiveHint`), validated inputs (zod).
- **Supply chain**: exact versions + `package-lock.json`, `ignore-scripts=true`, dependencies installed with a 14-day release cooldown, `npm audit` clean for production deps.
  Known dev-only finding: `minimatch` (moderate ReDoS) inside ESLint — not exploitable here (only our own glob config), no compatible fix yet.

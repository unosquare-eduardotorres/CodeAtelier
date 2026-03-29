# OWASP Patterns for Desktop Applications

## Top Security Concerns for Electron Desktop Apps

### 1. Injection Attacks
**Risk**: SQL injection via better-sqlite3, command injection via child_process
**Mitigation**:
- Always use parameterized queries: `db.prepare('SELECT * FROM users WHERE id = ?').get(id)`
- Never interpolate user input into SQL: `db.prepare(\`SELECT * FROM users WHERE id = '${id}'\`)` ← DANGEROUS
- For child_process, use `execFile` (not `exec`), pass args as array
- Validate all IPC inputs in main process before passing to services

### 2. Broken Authentication
**Risk**: Session hijacking, insecure token storage, missing logout
**Mitigation**:
- Store tokens via `safeStorage.encryptString()` + SQLite, not plain text
- Implement session timeout (idle + absolute)
- Clear all auth state on logout (memory + disk)
- Use PKCE for OAuth flows (no client secret needed for desktop apps)

### 3. Sensitive Data Exposure
**Risk**: Credentials in logs, unencrypted database, secrets in source
**Mitigation**:
- Sanitize logs: never log tokens, passwords, or API keys
- Encrypt sensitive SQLite columns with `safeStorage`
- Use `.env` + `.gitignore` for development secrets
- Use OS keychain (`keytar`) for production credential storage

### 4. Broken Access Control
**Risk**: Renderer accessing main process APIs without authorization
**Mitigation**:
- `contextIsolation: true` + `nodeIntegration: false` (mandatory)
- Preload exposes only typed IPC methods via `contextBridge`
- Every `ipcMain.handle` calls `validateSender(event)` first
- File system operations validate paths against allowed directories

### 5. Security Misconfiguration
**Risk**: Development settings in production, permissive CSP
**Mitigation**:
- Different CSP for dev vs production
- Electron Fuses locked at build time (prevent runtime toggling)
- No `webSecurity: false` in production
- Auto-update verifies code signatures

### 6. Cross-Site Scripting (XSS)
**Risk**: Rendering untrusted content in Electron's Chromium
**Mitigation**:
- React auto-escapes by default — never use `dangerouslySetInnerHTML` with user input
- CSP: `script-src 'self'` (no `unsafe-inline`, no `unsafe-eval`)
- Sanitize markdown rendering (DOMPurify for HTML output)
- `<webview>` tag: avoid if possible, use `sandbox` attribute if needed

### 7. Insecure Deserialization
**Risk**: Parsing untrusted JSON/NDJSON from Claude CLI output
**Mitigation**:
- `JSON.parse()` in try-catch, validate schema after parsing
- Validate expected types/fields before using parsed data
- Don't `eval()` or `new Function()` on received data

### 8. Insufficient Logging & Monitoring
**Risk**: Security events go unnoticed
**Mitigation**:
- Log authentication events (login, logout, token refresh, failure)
- Log IPC validation failures (potential attack attempts)
- Log file system access outside expected directories
- Rate-limit logging to prevent log injection / DoS

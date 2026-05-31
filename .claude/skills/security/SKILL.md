---
name: security
description: >
  Security analysis and hardening for desktop and web applications. Electron security,
  authentication patterns, OWASP best practices, threat modeling, and supply-chain hygiene.
---

# Security Skill — Application Security Patterns

## Purpose

Security analysis and hardening for desktop and web applications, with deep expertise in Electron security, authentication patterns, and OWASP best practices.

## Core Competencies

### Authentication & Authorization

- **OAuth 2.0 + PKCE**: Preferred for desktop apps (no client secret storage needed)
- **JWT Management**: Short-lived access tokens, secure refresh token rotation
- **API Key Security**: Scoped keys, rotation policies, never in source code
- **Session Management**: Timeout policies, concurrent session handling, secure logout
- **RBAC/ABAC**: Role-based and attribute-based access control patterns

### Input Validation & Sanitization

- **Validation Location**: Always validate on the trust boundary (main process for Electron)
- **Allowlist over Denylist**: Define what IS valid, not what ISN'T
- **Type Coercion**: Validate types before processing (string lengths, number ranges, enum values)
- **Path Traversal Prevention**: `path.resolve()` + validate within allowed directory
- **SQL Injection**: Parameterized queries (better-sqlite3 `?` placeholders), never string concatenation
- **XSS Prevention**: CSP headers, no `innerHTML` with user content, React auto-escaping

### Electron-Specific Security

- **Context Isolation**: Always `contextIsolation: true` — renderer cannot access Node.js
- **Node Integration**: Always `nodeIntegration: false` — prevent arbitrary code execution
- **Sandbox**: Enable `sandbox: true` for renderer processes
- **Preload Security**: Only expose typed IPC methods via `contextBridge.exposeInMainWorld`
- **Protocol Handlers**: Register custom protocols with `protocol.handle`, validate all URLs
- **Content Security Policy**: Strict CSP headers — no `unsafe-eval`, no `unsafe-inline`
- **WebPreferences Hardening**: Disable `webSecurity` bypass, `allowRunningInsecureContent`
- **Fuses**: Set Electron Fuses to prevent runtime toggles of security features

### Secret Management

- **Environment Variables**: Use `.env` files (gitignored) for development
- **OS Keychain**: Use `keytar` or `safeStorage` for persisting credentials
- **Never in Source**: No secrets in code, config files, or commit history
- **Encryption at Rest**: `safeStorage.encryptString()` for sensitive data in SQLite
- **Credential Rotation**: Support rotating credentials without downtime

### Attack Surface Analysis

- **IPC Channel Audit**: Every `ipcMain.handle` validates sender and sanitizes inputs
- **File System Access**: Minimize, validate paths, use `app.getPath()` for safe directories
- **External URLs**: Validate before `shell.openExternal()`, allowlist domains
- **Deep Links**: Validate custom protocol URLs, prevent command injection
- **Auto-Update**: Verify signatures, use HTTPS, validate update server identity

## Evaluation Criteria (for Grill Sessions)

When evaluating security posture, score based on:

1. **Auth Strategy (25%)**: Is authentication well-defined? Are tokens managed securely? Is session handling robust?
2. **Input Validation (25%)**: Are all trust boundaries identified? Is validation comprehensive? Are injection vectors covered?
3. **Electron Hardening (20%)**: Are context isolation, sandbox, CSP, and preload patterns correct?
4. **Secret Management (15%)**: Are credentials stored securely? Is rotation supported? Are secrets out of source?
5. **Attack Surface (15%)**: Are IPC channels validated? Is file access minimized? Are external URLs checked?

## Anti-Patterns to Flag

- Storing secrets in localStorage or SQLite without encryption
- Using `shell.openExternal()` with user-provided URLs without validation
- Disabling `contextIsolation` or enabling `nodeIntegration`
- Using `eval()`, `Function()`, or `innerHTML` with dynamic content
- Missing `validateSender()` in IPC handlers
- Sending raw error messages to renderer (information disclosure)
- Using `http://` for any external communication

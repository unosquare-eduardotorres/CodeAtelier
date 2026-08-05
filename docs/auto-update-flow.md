# Auto-Update Flow

> **Feature**: Automatic application updates via GitHub Releases + electron-updater
> **Date**: 2026-03-22

---

## 1. Sequence Diagram — Full Update Lifecycle

Shows every interaction from app launch through update installation, including the user-driven and automatic paths.

```mermaid
sequenceDiagram
    actor User
    participant Renderer as Renderer<br/>(React + Zustand)
    participant Preload as Preload Bridge<br/>(contextBridge)
    participant Main as Main Process<br/>(auto-update.service)
    participant GitHub as GitHub Releases

    Note over Main,GitHub: App Launch (production only)
    Main->>Main: autoUpdateService.init(mainWindow)
    Main->>Main: setTimeout(checkForUpdates, 5000)
    Main->>Main: startPeriodicChecks() — setInterval 60m + powerMonitor 'resume'

    rect rgb(40, 40, 70)
        Note over Main,GitHub: Automatic Check on Startup
        Main->>GitHub: GET latest-mac.yml / latest.yml
        alt Update Available
            GitHub-->>Main: version info (v1.1.0)
            Main-)Renderer: IPC update:available {version, releaseNotes}
            Renderer->>Renderer: setAvailable(version)
            Note over Renderer: UpdateBanner shows<br/>"v1.1.0 available!" + Download btn
        else No Update
            GitHub-->>Main: current version matches
            Main-)Renderer: IPC update:notAvailable
            Renderer->>Renderer: setNotAvailable()
        else Network Error
            GitHub-->>Main: error / timeout
            Main-)Renderer: IPC update:error "message"
            Renderer->>Renderer: setError(message)
            Note over Renderer: Red error banner appears
        end
    end

    rect rgb(45, 45, 60)
        Note over Main,GitHub: Background Polling (every 60 min, + on wake from sleep)
        loop While the app is open
            Main->>Main: maybeCheck() — skip if downloading,<br/>already downloaded, or checked < 15 min ago
            Main->>GitHub: GET latest-mac.yml / latest.yml
            GitHub-->>Main: version info
            Main-)Renderer: IPC update:available
            Note over Renderer: Modal opens — unless the user<br/>pressed "Later" on this version (4h snooze)
        end
    end

    rect rgb(40, 60, 40)
        Note over User,Renderer: User Clicks "Download"
        User->>Renderer: Click Download button
        Renderer->>Preload: window.api.downloadUpdate()
        Preload->>Main: ipcRenderer.invoke(update:download)
        Main->>GitHub: Download .dmg / .exe / .AppImage

        loop Download Progress
            GitHub-->>Main: bytes received
            Main-)Renderer: IPC update:progress {percent, bytesPerSecond}
            Renderer->>Renderer: setProgress(percent)
            Note over Renderer: Progress bar updates
        end

        GitHub-->>Main: Download complete
        Main-)Renderer: IPC update:downloaded {version}
        Renderer->>Renderer: setDownloaded(version)
        Note over Renderer: autoInstall is set — 3s countdown starts
    end

    rect rgb(60, 40, 40)
        Note over User,Main: Auto-Install (or "Restart now")
        Renderer->>Preload: window.api.installUpdate()
        Preload->>Main: ipcRenderer.invoke(update:install)
        Main->>Main: autoUpdater.quitAndInstall(true, true)
        Note over Main: Silent install (no NSIS UI),<br/>app relaunches on the new version
    end

    rect rgb(40, 50, 60)
        Note over User,Main: Alternative: user cancels the countdown
        User->>Renderer: Click "Not now — install on quit"
        Note over Renderer: Modal closes, update stays on disk
        User->>Main: Quit the app later
        alt Windows / Linux
            Main->>Main: before-quit → installOnQuitIfReady()<br/>quitAndInstall(true, false)
            Note over Main: autoInstallOnAppQuit cannot be relied on here:<br/>it hangs off the 'quit' event and before-quit<br/>ends in app.exit(0), which never emits it.
        else macOS
            Main->>Main: before-quit → installOnQuitIfReady() returns early
            Note over Main: autoInstallOnAppQuit already staged the update<br/>with Squirrel; ShipIt applies it when the process<br/>dies, which app.exit(0) does not bypass.<br/>Calling quitAndInstall() would RELAUNCH the app.
        end
    end

    rect rgb(50, 50, 40)
        Note over User,Renderer: Alternative: Manual Check from Settings
        User->>Renderer: Open Settings, click "Check for Updates"
        Renderer->>Preload: window.api.checkForUpdate()
        Preload->>Main: ipcRenderer.invoke(update:check)
        Main->>GitHub: GET latest-mac.yml
        GitHub-->>Main: version info
        Main-)Renderer: IPC update:available / update:notAvailable
    end
```

---

## 2. State Diagram — Update Status Lifecycle

Shows the Zustand store state transitions that drive the UI.

```mermaid
stateDiagram-v2
    [*] --> idle

    idle --> checking : checkForUpdates()

    checking --> available : update:available
    checking --> idle : update:notAvailable
    checking --> error : update:error

    available --> downloading : downloadUpdate()<br/>(sets autoInstall + showModal)
    available --> available : closeModal()<br/>snooze this version for 4h
    available --> idle : dismiss()<br/>also snoozes for 4h

    downloading --> ready : update:downloaded
    downloading --> error : update:error

    ready --> installing : autoInstall<br/>3s countdown
    installing --> [*] : installUpdate()<br/>silent install + relaunch
    installing --> ready : cancelAutoInstall()

    ready --> ready : dismiss()<br/>snoozes the banner; still installs on quit
    ready --> [*] : installUpdate()<br/>app restarts

    error --> idle : dismiss()
    error --> checking : checkForUpdates()

    note right of idle
        No update banner shown.
        Settings shows "Check for Updates" btn.
    end note

    note right of available
        Blue banner: "v1.1.0 available!"
        Download + Dismiss buttons.
        The banner honours the snooze;
        Settings never does.
    end note

    note right of downloading
        Circular progress ring: percentage,
        MB transferred, MB/s.
    end note

    note right of ready
        "Restarting in 3…" countdown.
        Cancelling defers to install-on-quit
        (explicit on Windows/Linux, Squirrel on macOS).
    end note

    note right of error
        Red banner with error message.
        Dismiss button available.
    end note
```

---

## 3. Flowchart — Architecture Overview

Shows how the auto-update feature fits into the Electron process architecture.

```mermaid
flowchart TB
    subgraph GH["GitHub Releases"]
        REL["latest-mac.yml<br/>+ .dmg / .exe installer"]
    end

    subgraph MAIN["Main Process (Node.js)"]
        AUS["AutoUpdateService<br/>auto-update.service.ts<br/>60m poll + resume catch-up"]
        IPC_H["update.ipc.ts<br/>IPC Handlers"]
        IDX["index.ts<br/>init + 5s check + startPeriodicChecks()<br/>before-quit → installOnQuitIfReady()"]

        IDX -->|"init(mainWindow)"| AUS
        IPC_H -->|"check / download / install"| AUS
    end

    subgraph PRE["Preload (contextBridge)"]
        API["window.api<br/>checkForUpdate()<br/>downloadUpdate()<br/>installUpdate()<br/>onUpdate*() listeners"]
    end

    subgraph REND["Renderer (React)"]
        APP["App.tsx<br/>Wire update listeners"]
        STORE["update.store.ts<br/>Zustand state"]
        BANNER["UpdateBanner.tsx<br/>Top-of-window banner<br/>(hidden while the modal is open)"]
        MODAL["UpdateAvailableModal.tsx<br/>Confirmation + progress ring"]
        SETTINGS["SettingsPage.tsx<br/>UpdateButton — opens the modal"]

        APP -->|"subscribe to events"| STORE
        STORE -->|"status drives UI"| BANNER
        STORE -->|"status drives UI"| MODAL
        STORE -->|"status drives UI"| SETTINGS
    end

    AUS <-->|"checkForUpdates()<br/>downloadUpdate()"| REL
    AUS -->|"send events via<br/>webContents.send()"| PRE
    PRE -->|"ipcRenderer.on()<br/>forward to callbacks"| APP
    BANNER -->|"user clicks"| API
    SETTINGS -->|"user clicks"| API
    API -->|"ipcRenderer.invoke()"| IPC_H

    classDef main fill:#1e3a5f,stroke:#4a90d9,color:#ffffff
    classDef preload fill:#3d2d5c,stroke:#8b5cf6,color:#ffffff
    classDef renderer fill:#1a3c34,stroke:#10b981,color:#ffffff
    classDef github fill:#3d2d1a,stroke:#f59e0b,color:#ffffff

    class AUS,IPC_H,IDX main
    class API preload
    class APP,STORE,BANNER,MODAL,SETTINGS renderer
    class REL github
```

---

## 4. Publishing Workflow

How you release a new version for your buddy to receive:

```mermaid
flowchart LR
    A["Bump version<br/>in package.json"] --> B["Build app<br/>npm run build:mac"]
    B --> C["Publish to GitHub<br/>--publish always"]
    C --> D["GitHub Release created<br/>v1.1.0"]
    D --> E["Buddy's app checks<br/>latest-mac.yml"]
    E --> F["Banner appears:<br/>Update available!"]
    F --> G["Download + Install"]

    classDef step fill:#1e3a5f,stroke:#4a90d9,color:#ffffff
    classDef github fill:#3d2d1a,stroke:#f59e0b,color:#ffffff
    classDef user fill:#1a3c34,stroke:#10b981,color:#ffffff

    class A,B,C step
    class D,E github
    class F,G user
```

---

## File Map

| Layer    | File                                                    | Role                                                                            |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Shared   | `src/shared/constants.ts`                               | 8 `UPDATE_*` IPC channel constants                                              |
| Main     | `src/main/services/auto-update.service.ts`              | Wraps `electron-updater`, 60m poll, install-on-quit (Win/Linux), forwards events |
| Main     | `src/main/ipc/update.ipc.ts`                            | IPC handlers: check, download, install                                          |
| Main     | `src/main/index.ts`                                     | Init + 5s startup check + `startPeriodicChecks()` + `installOnQuitIfReady()`    |
| Preload  | `src/preload/index.ts`                                  | Exposes `checkForUpdate`, `downloadUpdate`, `installUpdate` + 5 event listeners |
| Renderer | `src/renderer/src/store/update.store.ts`                | Zustand store: status, progress, snooze, auto-install countdown                  |
| Renderer | `src/renderer/src/store/update-store-utils.ts`          | Pure snooze rule (`nextSnooze` / `isSnoozed` / `isBannerMuted`) + mute scopes    |
| Renderer | `src/renderer/src/components/common/UpdateAvailableModal.tsx` | Confirmation modal: aurora hero, progress ring, countdown                 |
| Renderer | `src/renderer/src/components/common/UpdateBanner.tsx`   | Top-of-window banner (suppressed while the modal is open or the version is snoozed) |
| Renderer | `src/renderer/src/components/settings/UpdateButton.tsx` | "Check for Updates" / "Download vX" / "Install Update" — all open the modal     |
| Renderer | `src/renderer/src/hooks/useAppIpcListeners.ts`          | Wires IPC events to the Zustand store                                           |
| Renderer | `src/renderer/src/assets/main.css`                      | `update-*` keyframes: aurora, icon pulse, ring expand, check draw               |
| Config   | `electron-builder.yml`                                  | GitHub publish provider config                                                  |

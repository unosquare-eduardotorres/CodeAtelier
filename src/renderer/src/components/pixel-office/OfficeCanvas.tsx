/**
 * OfficeCanvas — React component wrapping the Canvas 2D pixel office rendering engine.
 *
 * Features:
 * - Left-click drag to pan
 * - Scroll wheel to zoom
 * - Zoom +/- buttons overlay
 * - Fit-to-view button
 * - Loads bundled default layout
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { OfficeState, startGameLoop, renderFrame } from './engine';
import type { OfficeLayout } from './engine/types';
import { TILE_SIZE } from './engine/types';
import { deserializeLayout } from './layout';
import { usePixelOfficeBridge, type PixelOfficeEngine } from '@renderer/hooks/usePixelOfficeBridge';
import { loadAllAssets } from './assetLoader';
import { SPRITE_ASSIGNMENTS } from './agentMapping';
import { ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import defaultLayoutJson from '@renderer/assets/pixel-office/default-layout.json';

const MIN_ZOOM = 1;
const MAX_ZOOM = 10;

interface OfficeCanvasProps {
  layout?: OfficeLayout | null;
}

export default function OfficeCanvas({ layout }: OfficeCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const officeStateRef = useRef<OfficeState | null>(null);
  const stopLoopRef = useRef<(() => void) | null>(null);
  const zoomRef = useRef(2);
  const panRef = useRef({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const engineRef = useRef<PixelOfficeEngine | null>(null);

  // Zoom state for UI display
  const [zoomLevel, setZoomLevel] = useState(2);

  // ── Fit the office to the container ──
  const fitToView = useCallback(() => {
    const container = containerRef.current;
    const office = officeStateRef.current;
    if (!container || !office) return;

    const rect = container.getBoundingClientRect();
    const layoutData = office.getLayout();
    const officeWidthPx = layoutData.cols * TILE_SIZE;
    const officeHeightPx = layoutData.rows * TILE_SIZE;

    // Calculate zoom to fit with some padding
    const padding = 20;
    const zoomX = (rect.width - padding * 2) / officeWidthPx;
    const zoomY = (rect.height - padding * 2) / officeHeightPx;
    const fitZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(Math.min(zoomX, zoomY))));

    // Center the office
    const scaledW = officeWidthPx * fitZoom;
    const scaledH = officeHeightPx * fitZoom;
    const panX = (rect.width - scaledW) / 2;
    const panY = (rect.height - scaledH) / 2;

    zoomRef.current = fitZoom;
    panRef.current = { x: panX, y: panY };
    setZoomLevel(fitZoom);
  }, []);

  // ── Initialize: load assets, then create office state and game loop ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    // Load all PNG assets first, then initialize the engine
    loadAllAssets().then(() => {
      if (cancelled) return;
      initEngine(canvas);
    });

    return () => {
      cancelled = true;
      if (stopLoopRef.current) stopLoopRef.current();
      officeStateRef.current = null;
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // ── Engine initialization (called after assets are loaded) ──
  function initEngine(canvas: HTMLCanvasElement): void {
    const officeLayout = layout || deserializeLayout(JSON.stringify(defaultLayoutJson)) || undefined;
    const office = new OfficeState(officeLayout);
    officeStateRef.current = office;

    // Add demo characters for all known agents so the office looks populated.
    // They start as IDLE (not active) so they wander around the office.
    // When real agents activate via the bridge hook, setAgentActive(id, true) makes them sit and type.
    const seatEntries = Array.from(office.seats.values());
    // Agent display names for labels
    const AGENT_NAMES: Record<string, string> = {
      orchestrator: 'Orchestrator',
      generalist: 'Generalist',
      'react-architect': 'React Architect',
      'dotnet-architect': '.NET Architect',
      'electron-architect': 'Electron Architect',
      'agentic-architect': 'Agentic Architect',
      'db-architect': 'DB Architect',
      'ux-ui-specialist': 'UX/UI Specialist',
      'git-github-specialist': 'Git Specialist',
      'requirements-specialist': 'Requirements',
      'code-planner': 'Code Planner',
      'execution-planner': 'Exec Planner',
      'cicd-devops': 'CI/CD DevOps',
      'cloud-infrastructure': 'Cloud Infra',
    };

    const agentEntries = Object.entries(SPRITE_ASSIGNMENTS);
    const idleZone = office.idleZoneTiles;
    agentEntries.forEach(([agentId, assignment], index) => {
      const numericId = index + 1;
      office.addAgent(numericId, assignment.spriteIndex, assignment.hueShift, undefined, true);
      // Set display name
      const ch = office.characters.get(numericId);
      if (ch) {
        ch.displayName = AGENT_NAMES[agentId] || agentId;
        // Spawn in break room (idle zone) instead of at desk
        if (idleZone.length > 0) {
          const spot = idleZone[Math.floor(Math.random() * idleZone.length)];
          ch.x = spot.col * 16 + 8; // TILE_SIZE / 2
          ch.y = spot.row * 16 + 8;
          ch.tileCol = spot.col;
          ch.tileRow = spot.row;
        }
      }
      // Assign desk seat (they'll walk there when activated)
      if (index < seatEntries.length) {
        office.reassignSeat(numericId, seatEntries[index].uid);
      }
      // Start idle — agents wander in break room until orchestrator activates them
      office.setAgentActive(numericId, false);
    });

    // Engine adapter for bridge hook
    engineRef.current = {
      addAgent(_id, numericId, spriteIndex, hueShift, seatIndex) {
        office.addAgent(numericId, spriteIndex, hueShift);
        const seatEntries = Array.from(office.seats.values());
        if (seatIndex < seatEntries.length) {
          office.reassignSeat(numericId, seatEntries[seatIndex].uid);
        }
      },
      removeAgent(numericId) { office.removeAgent(numericId); },
      setAgentActive(numericId, active) { office.setAgentActive(numericId, active); },
      setAgentTool(numericId, toolName) { office.setAgentTool(numericId, toolName); },
      showPermissionBubble(numericId, _text) { office.showPermissionBubble(numericId); },
      clearPermissionBubble(numericId) { office.clearPermissionBubble(numericId); },
      getTotalSeats() { return office.seats.size; },
      getAgentNumericId() { return undefined; }
    };

    const dpr = window.devicePixelRatio || 1;

    const stopLoop = startGameLoop(canvas, {
      update(dt) { office.update(dt); },
      render(ctx) {
        const w = canvas.width;
        const h = canvas.height;
        const layoutData = office.getLayout();

        renderFrame(
          ctx, w / dpr, h / dpr,
          office.tileMap, office.furniture, office.getCharacters(),
          zoomRef.current, panRef.current.x, panRef.current.y,
          {
            selectedAgentId: office.selectedAgentId,
            hoveredAgentId: office.hoveredAgentId,
            hoveredTile: office.hoveredTile,
            seats: office.seats,
            characters: office.characters
          },
          undefined,
          layoutData.tileColors, layoutData.cols, layoutData.rows
        );
      }
    });

    stopLoopRef.current = stopLoop;

    // Fit to view after canvas has been sized (double-raf to ensure layout is complete)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => fitToView());
    });
  }

  // ── Canvas sizing ──
  const updateCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  }, []);

  useEffect(() => {
    updateCanvasSize();
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      updateCanvasSize();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateCanvasSize]);

  // ── Zoom helpers ──
  const changeZoom = useCallback((delta: number) => {
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current + delta));
    zoomRef.current = newZoom;
    setZoomLevel(newZoom);
  }, []);

  // ── Mouse wheel zoom ──
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    changeZoom(e.deltaY > 0 ? -0.5 : 0.5);
  }, [changeZoom]);

  // ── Left-click drag to pan ──
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0 || e.button === 1) {
      e.preventDefault();
      isPanningRef.current = true;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      if (containerRef.current) {
        containerRef.current.style.cursor = 'grabbing';
      }
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanningRef.current) {
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      panRef.current = {
        x: panRef.current.x + dx,
        y: panRef.current.y + dy
      };
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanningRef.current = false;
    if (containerRef.current) {
      containerRef.current.style.cursor = 'grab';
    }
  }, []);

  // Bridge hook
  usePixelOfficeBridge(engineRef);

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative"
      style={{ overflow: 'hidden', cursor: 'grab' }}
    >
      <canvas
        ref={canvasRef}
        className="block"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />

      {/* Zoom controls overlay */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-gray-800/80 backdrop-blur-sm rounded-lg px-1.5 py-1 border border-gray-700/50">
        <button
          onClick={() => changeZoom(-1)}
          className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
          title="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <span className="text-[10px] text-gray-400 w-8 text-center font-mono">
          {zoomLevel}x
        </span>
        <button
          onClick={() => changeZoom(1)}
          className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
          title="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <div className="w-px h-4 bg-gray-600 mx-0.5" />
        <button
          onClick={fitToView}
          className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
          title="Fit to view"
        >
          <Maximize size={14} />
        </button>
      </div>

      {/* Info text overlay */}
      <div className="absolute top-2 left-3 text-[10px] text-gray-600">
        Drag to pan · Scroll to zoom
      </div>
    </div>
  );
}

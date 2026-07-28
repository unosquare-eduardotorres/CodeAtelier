// scripts/generate-dmg-background.mjs
// Run: node scripts/generate-dmg-background.mjs
// Deps: npm install canvas --save-dev (one-time)
//
// Generates build/background.png (660×400 @72 DPI)
//     and build/background@2x.png (1320×800 @144 DPI)

import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';

function renderBackground(width, height, scale, outputPath) {
  const w = width * scale;
  const h = height * scale;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  // ── Base: radial gradient ───────────────────────────────────────────
  const grad = ctx.createRadialGradient(
    w * 0.5, h * 0.55, 0,
    w * 0.5, h * 0.55, w * 0.5
  );
  grad.addColorStop(0, '#1a2830');
  grad.addColorStop(1, '#0f1517');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // ── Top accent line ─────────────────────────────────────────────────
  const lineGrad = ctx.createLinearGradient(w * 0.15, 0, w * 0.85, 0);
  lineGrad.addColorStop(0, 'transparent');
  lineGrad.addColorStop(0.5, 'rgba(184,151,106,0.2)');
  lineGrad.addColorStop(1, 'transparent');
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth = 1 * scale;
  ctx.beginPath();
  ctx.moveTo(w * 0.15, 0.5 * scale);
  ctx.lineTo(w * 0.85, 0.5 * scale);
  ctx.stroke();

  // ── Arrow: app icon → Applications ──────────────────────────────────
  const arrowY = 210 * scale;
  const arrowStartX = 240 * scale;
  const arrowEndX = 420 * scale;

  ctx.strokeStyle = 'rgba(184,151,106,0.25)';
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.moveTo(arrowStartX, arrowY);
  ctx.lineTo(arrowEndX - 12 * scale, arrowY);
  ctx.stroke();

  // Arrow head (filled triangle)
  ctx.fillStyle = 'rgba(184,151,106,0.25)';
  ctx.beginPath();
  ctx.moveTo(arrowEndX, arrowY);
  ctx.lineTo(arrowEndX - 14 * scale, arrowY - 7 * scale);
  ctx.lineTo(arrowEndX - 14 * scale, arrowY + 7 * scale);
  ctx.closePath();
  ctx.fill();

  // ── Instruction text ────────────────────────────────────────────────
  ctx.font = `italic ${12 * scale}px Georgia`;
  ctx.fillStyle = 'rgba(138,154,158,0.6)';
  ctx.textAlign = 'center';
  ctx.fillText('Drag to Applications to install', w / 2, 360 * scale);

  // ── Write PNG ───────────────────────────────────────────────────────
  writeFileSync(outputPath, canvas.toBuffer('image/png'));
  console.log(`✅ ${outputPath} (${w}×${h})`);
}

renderBackground(660, 400, 1, 'build/background.png');
renderBackground(660, 400, 2, 'build/background@2x.png');

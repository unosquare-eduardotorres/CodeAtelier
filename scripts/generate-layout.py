#!/usr/bin/env python3
"""Generate a custom office layout for 14 agents in Agent Studio.

Layout: 34x34 grid with 3 zones connected by a central corridor:
  - Main Office (top-left) — 7 desks with PCs, wood floor
  - Dev Room (top-right) — 7 desks with PCs, blue carpet
  - Break Room (full bottom) — lounge with sofas facing coffee tables
  - Central corridor connecting ALL rooms (no dead-end hallway)

Furniture placement rules:
  - DESK_FRONT is 3 wide × 2 tall, backgroundTiles=1 (top row is surface)
  - PCs go ON the desk surface (same col, desk.row = surface row)
  - Chairs go BELOW the desk (desk.row + 2), facing UP toward desk
  - Wall art (paintings, clocks, bookshelves) go ON wall tiles (row 0)
  - Coffee mugs go ON table surfaces, not on floor
  - Sofas face TOWARD the adjacent coffee table
"""

import json
import random
import string

W, H = 34, 34

VOID = 255
WALL = 0
WOOD = 7
BLUE = 1
CHECK = 9

def uid():
    tag = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
    return f"f-{tag}"

tiles = [VOID] * (W * H)

def set_tile(col, row, val):
    if 0 <= col < W and 0 <= row < H:
        tiles[row * W + col] = val

def fill_rect(c1, r1, c2, r2, val):
    for r in range(r1, r2 + 1):
        for c in range(c1, c2 + 1):
            set_tile(c, r, val)

furniture = []

def add(ftype, col, row):
    furniture.append({"uid": uid(), "type": ftype, "col": col, "row": row})


# ═══════════════════════════════════════════════════════════
# MAIN OFFICE (top-left): cols 0-14, rows 0-17
# Wall = row 0, row 17, col 0, col 14
# Floor = rows 1-16, cols 1-13 (WOOD)
# ═══════════════════════════════════════════════════════════
fill_rect(0, 0, 14, 17, WALL)
fill_rect(1, 1, 13, 16, WOOD)

# ── Wall decorations (ON wall tiles, row 0) ──
add("DOUBLE_BOOKSHELF", 1, 0)    # 2x2, on wall
add("SMALL_PAINTING", 4, 0)      # 1x2, on wall
add("HANGING_PLANT", 6, 0)       # 1x2, on wall
add("CLOCK", 8, 0)               # 1x2, on wall
add("BOOKSHELF", 10, 0)          # 2x1, on wall

# ── Row 1: 3 workstations (desks at row 2, chairs at row 4) ──
# DESK_FRONT = 3w × 2h. Top row (row 2) is surface for PCs.
# Chair at row 4, facing UP toward desk
for c in [1, 5, 9]:
    add("DESK_FRONT", c, 2)           # desk occupies (c,2)-(c+2,3)
    add("PC_FRONT_OFF", c + 1, 2)     # PC on desk surface (top row of desk)
    add("WOODEN_CHAIR_FRONT", c + 1, 4)  # chair below desk, facing UP

# ── Row 2: 4 workstations (desks at row 8, chairs at row 10) ──
for c in [1, 5, 9, 12]:
    add("DESK_FRONT", c, 8)
    add("PC_FRONT_OFF", c + 1, 8)     # PC on desk surface
    add("WOODEN_CHAIR_FRONT", c + 1, 10)

# ── Floor decor (plants, bins — NOT wall items) ──
add("PLANT", 13, 2)
add("PLANT_2", 1, 14)
add("BIN", 13, 16)


# ═══════════════════════════════════════════════════════════
# DEV ROOM (top-right): cols 19-33, rows 0-17
# Wall = row 0, row 17, col 19, col 33
# Floor = rows 1-16, cols 20-32 (BLUE)
# ═══════════════════════════════════════════════════════════
fill_rect(19, 0, 33, 17, WALL)
fill_rect(20, 1, 32, 16, BLUE)

# ── Wall decorations (ON wall tiles, row 0) ──
add("WHITEBOARD", 20, 0)          # 2x2, on wall
add("SMALL_PAINTING_2", 23, 0)    # 1x2, on wall
add("LARGE_PAINTING", 25, 0)      # 2x2, on wall
add("HANGING_PLANT", 28, 0)       # 1x2, on wall

# ── Row 1: 3 workstations ──
for c in [20, 24, 28]:
    add("DESK_FRONT", c, 2)
    add("PC_FRONT_OFF", c + 1, 2)
    add("WOODEN_CHAIR_FRONT", c + 1, 4)

# ── Row 2: 4 workstations ──
for c in [20, 24, 28, 30]:
    add("DESK_FRONT", c, 8)
    add("PC_FRONT_OFF", c + 1, 8)
    add("WOODEN_CHAIR_FRONT", c + 1, 10)

# ── Floor decor ──
add("PLANT", 20, 14)
add("PLANT_2", 32, 14)
add("BIN", 32, 16)


# ═══════════════════════════════════════════════════════════
# CENTRAL CORRIDOR: cols 15-18, rows 0-21
# Connects offices (top) to break room (bottom)
# No dead-end — runs full height
# ═══════════════════════════════════════════════════════════
fill_rect(15, 0, 18, 21, WALL)
fill_rect(16, 1, 17, 20, WOOD)

# ── Open doorways into offices (remove wall segments) ──
# Left door: col 15, rows 5-9 (into main office)
for r in range(5, 10):
    set_tile(15, r, WOOD)

# Right door: col 18, rows 5-9 (into dev room)
for r in range(5, 10):
    set_tile(18, r, BLUE)

# Bottom opening into break room: cols 16-17, row 20
set_tile(16, 20, CHECK)
set_tile(17, 20, CHECK)
set_tile(16, 21, CHECK)
set_tile(17, 21, CHECK)


# ═══════════════════════════════════════════════════════════
# BREAK ROOM (full bottom): cols 0-33, rows 21-33
# Accessed via corridor (cols 16-17) from offices
# ═══════════════════════════════════════════════════════════
fill_rect(0, 21, 33, 33, WALL)
fill_rect(1, 22, 32, 32, CHECK)

# ── Left doorway (main office → break room directly) ──
# Col 6-8, rows 17-21 (stairwell from main office)
fill_rect(6, 17, 8, 21, WALL)
for r in range(18, 22):
    for c in range(6, 9):
        set_tile(c, r, WOOD if r < 21 else CHECK)

# ── Right doorway (dev room → break room directly) ──
fill_rect(25, 17, 27, 21, WALL)
for r in range(18, 22):
    for c in range(25, 28):
        set_tile(c, r, BLUE if r < 21 else CHECK)

# ── Wall decorations (ON wall row 21 = break room top wall) ──
add("LARGE_PAINTING", 3, 21)
add("SMALL_PAINTING", 10, 21)
add("BOOKSHELF", 13, 21)
add("HANGING_PLANT", 20, 21)
add("SMALL_PAINTING_2", 22, 21)
add("LARGE_PAINTING", 29, 21)

# ── Lounge area 1 (left) — sofas facing inward toward table ──
add("COFFEE_TABLE", 3, 24)       # table at center
add("SOFA_SIDE", 2, 24)          # left sofa facing RIGHT (toward table)
add("SOFA_SIDE:left", 5, 24)     # right sofa facing LEFT (toward table)
add("COFFEE", 4, 24)             # mug ON table

# ── Lounge area 2 (center-left) — sofas facing table ──
add("COFFEE_TABLE", 10, 24)
add("SOFA_SIDE", 9, 24)
add("SOFA_SIDE:left", 12, 24)

# ── Lounge area 3 (center) — large table with benches ──
add("SMALL_TABLE_FRONT", 16, 24)
add("CUSHIONED_BENCH", 16, 26)
add("CUSHIONED_BENCH", 17, 26)

# ── Lounge area 4 (center-right) — sofas facing table ──
add("COFFEE_TABLE", 22, 24)
add("SOFA_SIDE", 21, 24)
add("SOFA_SIDE:left", 24, 24)
add("COFFEE", 23, 24)            # mug ON table

# ── Lounge area 5 (right) — sofas facing table ──
add("COFFEE_TABLE", 29, 24)
add("SOFA_SIDE", 28, 24)
add("SOFA_SIDE:left", 31, 24)

# ── Bottom row — more lounge groups ──
add("COFFEE_TABLE", 4, 29)
add("SOFA_SIDE", 3, 29)
add("SOFA_SIDE:left", 6, 29)

add("SMALL_TABLE_FRONT", 12, 29)
add("SOFA_SIDE", 11, 29)
add("SOFA_SIDE:left", 14, 29)

add("COFFEE_TABLE", 21, 29)
add("SOFA_SIDE", 20, 29)
add("SOFA_SIDE:left", 23, 29)

add("SMALL_TABLE_FRONT", 28, 29)
add("SOFA_SIDE", 27, 29)
add("SOFA_SIDE:left", 30, 29)

# ── Floor decor in break room (plants at edges, not blocking paths) ──
add("LARGE_PLANT", 1, 22)
add("CACTUS", 8, 22)
add("PLANT", 15, 22)
add("PLANT_2", 19, 22)
add("CACTUS", 26, 22)
add("LARGE_PLANT", 31, 22)
add("POT", 1, 32)
add("BIN", 8, 32)
add("PLANT", 25, 32)
add("POT", 32, 32)


# ═══════════════════════════════════════════════════════════
# BUILD OUTPUT
# ═══════════════════════════════════════════════════════════

layout = {
    "version": 3,
    "cols": W,
    "rows": H,
    "tiles": tiles,
    "tileColors": [],
    "furniture": furniture,
    "zones": {
        "breakRoom": {
            "colMin": 1, "colMax": 32,
            "rowMin": 22, "rowMax": 32,
            "description": "Break room — idle agents wander here"
        },
        "mainOffice": {
            "colMin": 1, "colMax": 13,
            "rowMin": 1, "rowMax": 16,
            "description": "Main office — core team desks"
        },
        "devRoom": {
            "colMin": 20, "colMax": 32,
            "rowMin": 1, "rowMax": 16,
            "description": "Dev room — specialist desks"
        }
    }
}

output_path = "/Users/eduardo.torres/Downloads/AgentStudio/src/renderer/src/assets/pixel-office/default-layout.json"
with open(output_path, 'w') as f:
    json.dump(layout, f)

print(f"Generated layout: {W}x{H}, {len(furniture)} furniture items")
print(f"Written to: {output_path}")

chair_count = sum(1 for item in furniture if 'CHAIR' in item['type'])
bench_count = sum(1 for item in furniture if 'BENCH' in item['type'])
print(f"Work chairs: {chair_count} (seats for working agents)")
print(f"Benches: {bench_count}")
print(f"Zones: main office, dev room, break room — connected via central corridor + side passages")

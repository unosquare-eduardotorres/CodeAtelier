#!/usr/bin/env python3
"""Generate a custom office layout for 14 agents in Agent Studio.

Layout: 34x34 grid with 3 zones connected by open passages:
  - Main Office (top-left) — 7 desks with PCs, wood floor
  - Dev Room (top-right) — 7 desks with PCs, blue carpet
  - Break Room (full bottom) — lounge with sofas, coffee tables, plants
  - Wide open passages connecting all rooms (no narrow hallway)

PLACEMENT RULES:
  - DESK_FRONT: 3w x 2h, backgroundTiles=1 (top row = surface for PCs)
  - PC goes at same (col, row) as desk — sits on the surface row
  - WOODEN_CHAIR_BACK: faces UP — correct for desks above the chair
  - Chair at desk.row + 2 (right below desk bottom edge)
  - Wall art: ON wall tiles (row=0 for offices, row=wall_row for break room)
  - Plants: corners and wall edges ONLY, never mid-floor
  - Coffee/mugs: ONLY on table surfaces, never on floor
  - Sofas face INWARD toward their coffee table
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
# MAIN OFFICE (top-left): cols 0-15, rows 0-18
# Walls: row 0, row 18, col 0, col 15
# Floor (WOOD): rows 1-17, cols 1-14
# ═══════════════════════════════════════════════════════════
fill_rect(0, 0, 15, 18, WALL)
fill_rect(1, 1, 14, 17, WOOD)

# -- Wall decorations (ON the wall = row 0, col 0, or col 15) --
add("DOUBLE_BOOKSHELF", 1, 0)    # top wall, left corner
add("BOOKSHELF", 4, 0)           # top wall
add("SMALL_PAINTING", 7, 0)      # top wall
add("CLOCK", 9, 0)               # top wall
add("BOOKSHELF", 11, 0)          # top wall
add("HANGING_PLANT", 14, 0)      # top wall, right corner

# -- Row 1 workstations: 3 desks --
# Desk at row 3 (surface=row3, body=row4), chair at row 5 facing UP
for c in [1, 5, 9]:
    add("DESK_FRONT", c, 3)           # 3w x 2h at (c, 3)-(c+2, 4)
    add("PC_FRONT_OFF", c + 1, 3)     # PC on desk surface (top row)
    add("WOODEN_CHAIR_BACK", c + 1, 5)  # chair facing UP toward desk

# -- Row 2 workstations: 4 desks --
# Desk at row 9, chair at row 11
for c in [1, 5, 9, 12]:
    add("DESK_FRONT", c, 9)
    add("PC_FRONT_OFF", c + 1, 9)
    add("WOODEN_CHAIR_BACK", c + 1, 11)

# -- Corner plants (edges only, not mid-floor) --
add("PLANT", 14, 1)           # top-right corner of room
add("PLANT_2", 1, 16)         # bottom-left corner
add("BIN", 14, 17)            # bottom-right corner

# -- Bookshelves on side walls --
add("DOUBLE_BOOKSHELF", 1, 14)   # left wall, bottom area
add("BOOKSHELF", 13, 14)         # right wall area


# ═══════════════════════════════════════════════════════════
# DEV ROOM (top-right): cols 18-33, rows 0-18
# Walls: row 0, row 18, col 18, col 33
# Floor (BLUE): rows 1-17, cols 19-32
# ═══════════════════════════════════════════════════════════
fill_rect(18, 0, 33, 18, WALL)
fill_rect(19, 1, 32, 17, BLUE)

# -- Wall decorations (top wall = row 0) --
add("WHITEBOARD", 19, 0)         # top wall, left
add("BOOKSHELF", 22, 0)          # top wall
add("SMALL_PAINTING_2", 25, 0)   # top wall
add("LARGE_PAINTING", 27, 0)     # top wall (2w)
add("BOOKSHELF", 30, 0)          # top wall
add("HANGING_PLANT", 32, 0)      # top wall, right corner

# -- Row 1 workstations: 3 desks --
for c in [19, 23, 27]:
    add("DESK_FRONT", c, 3)
    add("PC_FRONT_OFF", c + 1, 3)
    add("WOODEN_CHAIR_BACK", c + 1, 5)

# -- Row 2 workstations: 4 desks --
for c in [19, 23, 27, 30]:
    add("DESK_FRONT", c, 9)
    add("PC_FRONT_OFF", c + 1, 9)
    add("WOODEN_CHAIR_BACK", c + 1, 11)

# -- Corner plants --
add("PLANT", 19, 1)           # top-left corner
add("PLANT_2", 32, 16)        # bottom-right corner
add("BIN", 32, 17)            # corner

# -- Bookshelves on walls --
add("DOUBLE_BOOKSHELF", 19, 14)
add("BOOKSHELF", 31, 14)


# ═══════════════════════════════════════════════════════════
# OPEN PASSAGES — connect offices to break room
# No narrow hallway — wide openings directly between rooms
# ═══════════════════════════════════════════════════════════

# Central passage (cols 15-18, rows 6-21) — connects both offices + break room
# Clear the wall between offices and make a wide floor path
fill_rect(15, 0, 18, 21, WALL)       # base: walls
fill_rect(15, 6, 18, 20, WOOD)       # floor: open passage rows 6-20

# Open into main office (col 15, rows 6-12)
for r in range(6, 13):
    set_tile(15, r, WOOD)

# Open into dev room (col 18, rows 6-12)
for r in range(6, 13):
    set_tile(18, r, BLUE)

# Left direct passage (main office → break room): cols 6-8, rows 18-21
fill_rect(6, 18, 8, 21, WALL)
for r in range(18, 22):
    for c in range(6, 9):
        set_tile(c, r, WOOD if r <= 18 else CHECK)

# Right direct passage (dev room → break room): cols 25-27, rows 18-21
fill_rect(25, 18, 27, 21, WALL)
for r in range(18, 22):
    for c in range(25, 28):
        set_tile(c, r, BLUE if r <= 18 else CHECK)

# Central passage opens into break room (cols 15-18, rows 20-21)
for c in range(15, 19):
    set_tile(c, 20, CHECK)
    set_tile(c, 21, CHECK)


# ═══════════════════════════════════════════════════════════
# BREAK ROOM (full bottom): cols 0-33, rows 21-33
# Walls: row 21 (top), row 33 (bottom), col 0, col 33
# Floor (CHECK): rows 22-32, cols 1-32
# ═══════════════════════════════════════════════════════════
fill_rect(0, 21, 33, 33, WALL)
fill_rect(1, 22, 32, 32, CHECK)

# -- Wall decorations (top wall = row 21) --
add("LARGE_PAINTING", 2, 21)
add("BOOKSHELF", 5, 21)
add("SMALL_PAINTING", 10, 21)
add("HANGING_PLANT", 13, 21)
add("SMALL_PAINTING_2", 20, 21)
add("BOOKSHELF", 23, 21)
add("LARGE_PAINTING", 29, 21)

# -- Lounge group 1 (left): sofa-table-sofa facing inward --
# SOFA_SIDE faces RIGHT, SOFA_SIDE:left faces LEFT
# Coffee table between them
add("SOFA_SIDE", 2, 24)          # left sofa, faces right
add("COFFEE_TABLE", 3, 24)       # table (2x2)
add("SOFA_SIDE:left", 5, 24)     # right sofa, faces left

# -- Lounge group 2 (center-left) --
add("SOFA_SIDE", 9, 24)
add("COFFEE_TABLE", 10, 24)
add("SOFA_SIDE:left", 12, 24)

# -- Lounge group 3 (center): small table with benches --
add("SMALL_TABLE_FRONT", 16, 24)    # 2x2 table
add("CUSHIONED_BENCH", 16, 26)
add("CUSHIONED_BENCH", 17, 26)

# -- Lounge group 4 (center-right) --
add("SOFA_SIDE", 21, 24)
add("COFFEE_TABLE", 22, 24)
add("SOFA_SIDE:left", 24, 24)

# -- Lounge group 5 (right) --
add("SOFA_SIDE", 28, 24)
add("COFFEE_TABLE", 29, 24)
add("SOFA_SIDE:left", 31, 24)

# -- Bottom row lounge groups --
add("SOFA_SIDE", 3, 29)
add("COFFEE_TABLE", 4, 29)
add("SOFA_SIDE:left", 6, 29)

add("SOFA_SIDE", 11, 29)
add("SMALL_TABLE_FRONT", 12, 29)
add("SOFA_SIDE:left", 14, 29)

add("SOFA_SIDE", 20, 29)
add("COFFEE_TABLE", 21, 29)
add("SOFA_SIDE:left", 23, 29)

add("SOFA_SIDE", 27, 29)
add("SMALL_TABLE_FRONT", 28, 29)
add("SOFA_SIDE:left", 30, 29)

# -- Corner/edge plants ONLY (no mid-floor plants) --
add("LARGE_PLANT", 1, 22)        # top-left corner
add("CACTUS", 1, 31)             # bottom-left corner
add("LARGE_PLANT", 32, 22)       # top-right corner
add("PLANT", 32, 31)             # bottom-right corner
add("PLANT_2", 8, 22)            # along top wall edge
add("CACTUS", 26, 22)            # along top wall edge

# -- Corner items --
add("POT", 1, 32)
add("BIN", 32, 32)


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
            "description": "Break room - idle agents wander here"
        },
        "mainOffice": {
            "colMin": 1, "colMax": 14,
            "rowMin": 1, "rowMax": 17,
            "description": "Main office - core team desks"
        },
        "devRoom": {
            "colMin": 19, "colMax": 32,
            "rowMin": 1, "rowMax": 17,
            "description": "Dev room - specialist desks"
        }
    }
}

output_path = "/Users/eduardo.torres/Downloads/AgentStudio/src/renderer/src/assets/pixel-office/default-layout.json"
with open(output_path, 'w') as f:
    json.dump(layout, f)

print(f"Generated layout: {W}x{H}, {len(furniture)} furniture items")
print(f"Written to: {output_path}")

chair_count = sum(1 for item in furniture if 'CHAIR' in item['type'])
print(f"Work chairs: {chair_count} (seats for 14 agents)")
print()
print("Fixes applied:")
print("  - Chairs use WOODEN_CHAIR_BACK (faces UP toward desk)")
print("  - PCs at desk.row (on surface, not on wall)")
print("  - All wall art on wall tiles (row 0 or row 21)")
print("  - Plants ONLY at corners/edges, never mid-floor")
print("  - No coffee mugs on floor (only on table surfaces)")
print("  - Wide open passages (4 tiles wide) + 2 side passages")
print("  - More bookshelves in both offices")
print("  - Desks at row 3 (not row 2) to avoid wall overlap")

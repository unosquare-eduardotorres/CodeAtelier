# Code Atelier — Artisan's Seal Icon Generation Prompts

> **Purpose**: Ready-to-use prompts for AI image generators (Midjourney, DALL-E, Ideogram, Flux).
> Generated: 2026-05-01

---

## Master Prompt (Base — Original Gold)

```
A macOS app icon, exactly 1024x1024 pixels, perfectly square, no cropping,
no text overlays, no watermarks, no UI elements.

A luxurious dark wax seal centered on a deep obsidian background. The seal
has an organic, slightly irregular wax edge — not a perfect circle — giving
it an authentic handcrafted feel. The seal surface is dark leather-textured
wax.

Around the inner face of the seal, an ornate circular frame of Renaissance-era
gold filigree — scrollwork, vine-like flourishes, fine engraved detail. The
filigree catches light with a warm metallic sheen.

In the center of the seal, the code brackets </> are embossed in BRIGHT
champagne-gold with strong luminance contrast against the dark seal face.
The brackets must be clearly legible — they should read as raised metallic
lettering catching light, NOT as a dark subtle deboss. This is critical:
the </> must be recognizable even when the icon is scaled down to 64px.

At the top of the seal, a single faceted gemstone is set into the wax —
it glows with inner light and has realistic refraction. The gem is the
focal accent point of the entire icon.

The background is a dark rounded square (macOS squircle shape) in near-black
(#0F1517). A subtle warm radial glow emanates from behind the seal. Fine
grain texture at 3% opacity across the entire surface.

Studio lighting from above-left. 3D rendered, photorealistic materials,
ultra-premium quality. The overall mood is: a master craftsman's personal
signet — dark, refined, authoritative.
```

---

## Color Variant Modifiers

Append ONE of these blocks after the master prompt to change the palette.

---

### Variant A — "Midnight Silver & Sapphire"

_Cool, modern, high-tech elegance_

```
COLOR OVERRIDE: The filigree frame and </> brackets are polished sterling
silver with cool blue-white highlights — no gold tones. The gemstone is a
deep royal blue sapphire with bright star-light refraction and a cool white
inner glow. The ambient radial glow behind the seal is cool moonlight blue.
The seal wax is dark slate-blue tinted. Overall atmosphere: cold, precise,
lunar.
```

---

### Variant B — "Gunmetal & Amethyst"

_Dark, moody, mysterious — the hacker's atelier_

```
COLOR OVERRIDE: The filigree frame is dark gunmetal / brushed dark chrome
with very subtle reflections — almost black metal. The </> brackets are
cool pewter-silver, bright enough to read against the dark seal. The
gemstone is a deep violet amethyst with a purple inner glow that bleeds
faint violet light onto the surrounding wax. The seal wax is matte black
obsidian-like. The radial glow behind the seal is very subtle violet.
Overall atmosphere: nocturnal, enigmatic.
```

---

### Variant C — "Rose Gold & Garnet"

_Warm but refined, luxury editorial feel_

```
COLOR OVERRIDE: The filigree frame and </> brackets are rose gold with
warm pink-copper highlights. The gemstone is a deep crimson garnet with
warm red inner refraction — like a drop of wine captured in crystal. The
seal wax is dark charcoal with warm undertones. The radial glow behind
the seal is soft rose-gold. Overall atmosphere: warm, editorial, intimate.
```

---

### Variant D — "Antique Brass & Emerald"

_Aged, weathered, alchemist's workshop_

```
COLOR OVERRIDE: The filigree frame is antique brass with a subtle green
verdigris patina visible in the filigree crevices — it looks centuries old.
The </> brackets are warm aged brass, slightly tarnished but still legible.
The gemstone is a rich deep emerald with a green crystalline inner glow.
The seal wax is dark olive-tinted aged wax. The radial glow is warm amber.
Overall atmosphere: ancient, alchemical, a tool found in da Vinci's desk.
```

---

### Variant E — "Platinum & Opal"

_Ethereal, iridescent, Apple-esque premium_

```
COLOR OVERRIDE: The filigree frame and </> brackets are bright platinum /
white gold with clean highlights. The gemstone is an iridescent opal
showing shifting prismatic colors (blue, green, pink shimmer) with a soft
rainbow glow. The seal wax is dark matte charcoal, neutral. The radial
glow is neutral white with faint prismatic edges. Overall atmosphere:
ethereal, futuristic, precious.
```

---

### Variant F — "Aged Gold & Teal Aquamarine" ⭐ Brand-Native

_Closest to the Code Atelier palette — evolved, not replaced_

```
COLOR OVERRIDE: Keep the gold filigree but make it slightly darker and
more antique — aged gold (#9A7B4F) with deeper patina in the engravings.
The </> brackets are bright champagne gold (#C8B89A) — the brightest
element. The gemstone is a teal aquamarine stone with a cool cyan-green
inner glow — NOT amber/orange. The seal wax matches the app background
(#1C272D dark teal-black). The radial glow is warm gold with teal accent
reflections on the seal edges. This feels like the Code Atelier brand
palette made into a physical artifact.
```

---

### Variant G — "Blackened Steel & Diamond"

_Ultra-minimal, monochromatic, brutalist luxury_

```
COLOR OVERRIDE: The filigree frame is blackened steel / dark iron with
metallic highlights only catching light at the very edges. The </> brackets
are lighter grey steel — visible through luminance contrast only, no color.
The gemstone is a brilliant-cut clear diamond with sharp white light
refraction and subtle rainbow caustics — the ONLY color in the entire icon.
The seal wax is matte black. The radial glow is very faint neutral white.
Overall atmosphere: monochrome brutalist luxury, maximum restraint.
```

---

## Production Notes

### Resolution

- Always generate at **1024×1024 minimum** (2048×2048 preferred for downscaling headroom)
- Source image must be **perfectly square**
- Verify no watermarks, "Edit" buttons, or UI chrome leaked into the output

### Small-Size Readability

The `</>` brackets MUST have strong luminance contrast against the seal center.
Test by shrinking the result to 64×64 — if you can't read `</>`, regenerate with:

```
Make the </> brackets even brighter and larger — they should be the
brightest element inside the seal, with clear metallic highlights that
catch light even at small sizes.
```

### Size-Specific Variants (Advanced)

For production macOS icons, consider generating 2–3 detail tiers:

| Tier       | Sizes      | Detail Level                                                         |
| ---------- | ---------- | -------------------------------------------------------------------- |
| **Micro**  | 16–32px    | Simplified: seal circle + jewel dot + bold bright `</>`, no filigree |
| **Medium** | 64–128px   | Seal + filigree ring + jewel + clear `</>`                           |
| **Full**   | 256–1024px | All detail: filigree, leather texture, gem refraction, grain         |

### Micro-Icon Prompt (16–32px optimization)

```
A macOS app icon, 1024x1024, extremely simplified for scaling to tiny sizes.
A dark circular seal shape on near-black background. A single bright gold
ring around the edge. Bold, bright </> brackets in the center — maximum
contrast, no subtlety. A single bright colored dot at the top (the jewel).
No filigree, no texture, no fine detail. Just: dark circle, gold ring,
bright </> brackets, jewel dot. Clean, bold, iconic. macOS squircle shape.
```

---

## Recommended Generation Workflow

1. Generate the **Master Prompt + Variant F** (brand-native) as the primary candidate
2. Generate **Master Prompt + Variant B** (gunmetal/amethyst) as the bold alternative
3. Generate **Master Prompt + Variant D** (brass/emerald) as the Renaissance alternative
4. Pick the winner, then generate the **Micro-Icon Prompt** with matching colors
5. Use `scripts/render-icon.ts` to produce all required macOS sizes from the 1024px source

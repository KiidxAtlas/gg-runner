# Accurate Arms — GCode Library Standard

This document is the authoritative reference for how all files in `Code/` work,
how they interact, and how to create new files from scratch.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Workflow Sequence](#2-workflow-sequence)
3. [Register Reference](#3-register-reference)
4. [M-Code Reference](#4-m-code-reference)
5. [Named Variable Registry](#5-named-variable-registry)
6. [slide_type Values](#6-slide_type-values)
7. [footprint_type Values](#7-footprint_type-values)
8. [File Templates](#8-file-templates)
9. [How to Add a New Footprint](#9-how-to-add-a-new-footprint)
10. [How to Add a New Slide Type](#10-how-to-add-a-new-slide-type)
11. [Common Pitfalls](#11-common-pitfalls)

---

## 1. System Overview

The runner (GG Runner) executes a sequence of gcode files against the CNC
machine.  Files are plain gcode with additional custom **M-codes** (M100–M108)
that let you do math, store/load named variables, and halt with an error when
the wrong slide type is loaded.

All distances sent to the machine are in **millimeters** (G21).  Offsets stored
in named variables are in **inches** and are converted to mm inside M102
expressions with `* 25.4`.

The probe origin is the **front-centre of the slide as clamped**.  G59X/Y/Z
hold this origin after probing.  All other positions are computed relative to
G59.

---

## 2. Workflow Sequence

Each run goes through these phases in order.  You cannot skip phases.

```
Phase           File(s) run
──────────────────────────────────────────────────────────────────────────────
1. Position     Code/Slide_Positioning/<slide> Slide 5 position of slide.gcode
2. Probe        Code/Slide_Probing/<slide> Slide Probe 1.5 - 2.5 OAL.nc
3. Configure    Code/Slide_Configs/<slide>_configure.gcode
4. Mill         a) Code/Footprint_Configs/<footprint>_<position>_config.gcode
                b) Code/Depth_Setting/<depth>.gcode
                c) Code/Footprint_Milling/<footprint>.gcode
5. Holes        Code/tool_change.gcode
                  → user instruction: install 1/16" endmill
                Code/Slide_Probing/Z Reprobe 1.5 - 2.5 OAL.nc
                Code/Hole_Cutting/set_left_hole.gcode
                Code/Hole_Cutting/<thread>_1-16.gcode  (bore left)
                Code/Hole_Cutting/set_right_hole.gcode
                Code/Hole_Cutting/<thread>_1-16.gcode  (bore right)
                Code/tool_change.gcode
                  → user instruction: install threadmill
                Code/Hole_Cutting/set_left_hole.gcode
                Code/Hole_Cutting/<thread>_threadmill.gcode  (thread left)
                Code/Hole_Cutting/set_right_hole.gcode
                Code/Hole_Cutting/<thread>_threadmill.gcode  (thread right)
──────────────────────────────────────────────────────────────────────────────
Thread types:  4-40  |  M3  |  6-32
```

**What each phase does:**

| Phase | What it sets |
|---|---|
| Position | Moves to slide-loading position; nothing stored |
| Probe | Sets G59X (centre-X), G59Y (front of slide), G59Z (top of slide) |
| Configure | Sets `slide_type` + all offset named vars for that slide |
| Footprint Config | Loads offset → computes G54Y; computes G55/G56 hole positions; sets `footprint_type` |
| Depth Setting | Sets the Z work offset for cut depth (G54Z or similar) |
| Mill | Cuts the optic pocket using G54/G55/G56 as references |
| Holes | Reprobe Z with bore endmill, cut & thread both mounting holes |

---

## 3. Register Reference

### WCS registers — synced to the machine
These map to the machine's Work Coordinate Systems.  Writing to them moves the
actual WCS offsets on the controller.

| Register | Role |
|---|---|
| G54X/Y/Z | Primary optic-pocket origin (front-left corner of pocket) |
| G55X/Y | Left mounting hole position |
| G56X/Y | Right mounting hole position |
| G57X/Y/Z | Secondary / spare WCS (rarely used externally) |

### Scratch registers — computation only
These are **not** sent to the machine.  Use them freely for intermediate math.

| Register | Convention |
|---|---|
| G58X | Scratch — usually holds `slide_type` for sanity checks |
| G58Y | Scratch — usually holds the result of `if()` for M106 tests |
| G58Z | Scratch — usually holds `sanity_checks_disabled` |
| G59X | Set by Probe — slide centre X (never overwrite after probing) |
| G59Y | Set by Probe — slide front Y (never overwrite after probing) |
| G59Z | Set by Probe — slide top Z (never overwrite after probing) |

> **Rule:** G59X/Y/Z are sacred after probing.  Never write G59 from a config
> or mill file.  Always read it and compute offsets from it.

---

## 4. M-Code Reference

### M100 — Midpoint

```
M100 DEST SRC_A SRC_B
```

Sets DEST = (SRC_A + SRC_B) / 2.

**Example:**
```gcode
M100 G54X G55X G56X    (G54X = average of left and right hole X — i.e. centre of slide)
```

---

### M102 — Compute expression

```
M102 DEST EXPRESSION
```

Evaluates EXPRESSION and stores the result in DEST.  The expression is always
wrapped in `(...)` parentheses — this is **not** a comment; DDcut treats it as a
math expression.

**Supported operations:**

| Syntax | Meaning |
|---|---|
| `+` `-` `*` `/` | Basic arithmetic |
| `floor(X)` | Round down to integer |
| `abs(X)` | Absolute value |
| `sqrt(X)` | Square root |
| `if(COND, TRUE_VAL, FALSE_VAL)` | Conditional — returns TRUE_VAL when COND is non-zero, else FALSE_VAL |
| `or` `and` | Logical operators (use inside `if` conditions) |
| `==` `!=` `>` `<` `>=` `<=` | Comparison operators (result is 1 or 0) |

**Unit conversion:** named offsets are stored in **inches**.  Multiply by 25.4
to get millimetres before assigning to a WCS register.

**Example:**
```gcode
M108 G58Y rmr_standard              (load offset in inches into scratch)
M102 G54Y (G59Y - (G58Y * 25.4))   (compute pocket front Y in mm)
```

---

### M106 — Conditional halt (sanity check)

```
M106 REG OPERATOR VALUE Error: message
```

If the condition `REG OPERATOR VALUE` is **true**, execution stops and the error
message is displayed to the operator.

**Operators:** `==`  `!=`  `>`  `<`  `>=`  `<=`

#### The standard sanity-check pattern

Always use this two-line pattern:

```gcode
M102 G58Y if((CONDITION_IS_CORRECT), 0, 1)
M106 G58Y == 1 Error: Your message here.
```

- The `if()` stores **0** when the condition is **correct** (OK to continue).
- The `if()` stores **1** when the condition is **wrong** (should halt).
- `M106 G58Y == 1` fires (halts) when G58Y is 1 — i.e. when something is wrong.

**Why G58Y == 1, not == 0?**  Because `if(correct, 0, 1)` puts 0 in G58Y when
we are correct.  Firing on 0 would halt when everything is fine — backwards.

**Example — block a footprint on a wrong slide:**
```gcode
M108 G58X slide_type
M108 G58Z sanity_checks_disabled

(Only allowed on G17/19/26 and G20)
M102 G58Y if((((G58X == 1) or (G58X == 5) or (G58Z == 1))), 0, 1)
M106 G58Y == 1 Error: This footprint can only be milled on G17/19/26 or G20 slides.
```

Conditions in the `if()`:
- `G58X == 1` → correct slide (G17/19/26)
- `G58X == 5` → also correct (G20)
- `G58Z == 1` → sanity checks disabled, always pass

Any of these being true makes the overall condition true → 0 stored → no halt.

**Example — restrict to 1911 only:**
```gcode
M102 G58Y if((((G58X == 3) or (G58Z == 1))), 0, 1)
M106 G58Y == 1 Error: This cut can only be milled on a 1911 slide.
```

---

### M107 — Store named variable

```
M107 var_name numeric_value
```

Stores a number under a string name in persistent memory.  Values survive
between files within the same job run.

**Example:**
```gcode
M107 slide_type 1
M107 rmr_standard 2.213
```

---

### M108 — Load named variable into register

```
M108 REGISTER var_name
```

Reads the named variable back into a scratch or WCS register for use in M102 or
M106 expressions.

**Example:**
```gcode
M108 G58X slide_type          (load slide_type into G58X for comparisons)
M108 G58Y rmr_standard        (load offset inches into G58Y for math)
```

---

## 5. Named Variable Registry

These are the named variables used across the system.  **Offsets are in inches**
and represent the distance from the probe origin (G59Y) to the front edge of the
optic pocket along the Y axis.

### State variables

| Name | Set by | Meaning |
|---|---|---|
| `slide_type` | Slide configure file | Identifies the slide — see §6 |
| `footprint_type` | Footprint config file | Identifies the footprint — see §7 |
| `sanity_checks_disabled` | Disable sanity job | 1 = bypass all M106 checks |

### Offset variables (inches from probe origin to pocket front edge)

| Variable name | G17/19/26 | G43/48 | 1911 | P320 | G20 | M&P 2.0 |
|---|---|---|---|---|---|---|
| `rmr_standard` | 2.213 | — | — | 1.988 | 2.300 | 1.750 |
| `rmr_rear` | 2.604 | — | — | 2.421 | 2.700 | 2.250 |
| `docter_standard` | 2.251 | — | — | 2.029 | 2.300 | — |
| `docter_rear` | 2.651 | — | — | 2.421 | 2.700 | 2.575 |
| `mos_rear` | 2.585 | — | — | — | 2.700 | — |
| `mos_1911_standard` | — | — | -0.1945 | — | — | — |
| `rms_standard` | 2.189 | — | — | 2.106 | 2.300 | — |
| `rms_rear` | 2.628 | 2.415 | 2.1005 | 2.362 | 2.700 | 2.575 |
| `rmrcc_standard` | 2.213 | — | — | 1.988 | 2.300 | — |
| `rmrcc_rear` | 2.604 | 2.500 | 2.1005 | 2.421 | 2.700 | 2.575 |
| `viper_standard` | 2.213 | — | — | 2.000 | 2.300 | — |
| `viper_rear` | 2.604 | — | — | 2.415 | 2.700 | 2.470 |
| `razor_standard` | 2.213 | — | — | 2.000 | 2.300 | — |
| `razor_rear` | 2.604 | — | — | 2.415 | 2.700 | 2.430 |
| `delta_point_pro_standard` | 2.213 | — | — | 2.000 | 2.300 | — |
| `delta_point_pro_rear` | 2.604 | — | — | 2.415 | 2.700 | 2.450 |

**—** means that footprint/slide combination is not offered.

---

## 6. slide_type Values

| Value | Slide |
|---|---|
| 1 | Glock 17 / 19 / 26 |
| 2 | Glock 43 / 48 |
| 3 | 1911 |
| 4 | P320 |
| 5 | Glock 20 |
| 6 | M&P 2.0 |

---

## 7. footprint_type Values

| Value | Config file(s) | Optic / pattern |
|---|---|---|
| 1 | `rmr_standard_config.gcode` | RMR / Holosun 407C·507C — Standard |
| 2 | `rmr_rear_config.gcode` | RMR / Holosun 407C·507C — Rear |
| 3 | `docter_standard_config.gcode` | Docter / Vortex Venom — Standard |
| 4 | `docter_rear_config.gcode` | Docter / Vortex Venom — Rear |
| 5 | `mos_1911_rear_config.gcode` / `mos_rear_config.gcode` | MOS — Rear |
| 6 | `rms_standard_config.gcode` | RMS / RMSc / Romeo Zero — Standard |
| 7 | `rms_rear_config.gcode` | RMS / RMSc / Romeo Zero — Rear |
| 8 | `rmrcc_standard_config.gcode` | RMRcc — Standard |
| 9 | `rmrcc_rear_config.gcode` | RMRcc — Rear |
| 10 | `viper_standard_config.gcode` | Vortex Viper — Standard |
| 11 | `viper_rear_config.gcode` | Vortex Viper — Rear |
| 12 | `razor_standard_config.gcode` | Vortex Razor — Standard |
| 13 | `razor_rear_config.gcode` | Vortex Razor — Rear |
| 14 | `dpp_standard_config.gcode` | Delta Point Pro — Standard |
| 15 | `dpp_rear_config.gcode` | Delta Point Pro — Rear |
| 16 | `mos_1911_standard_config.gcode` | 1911 MOS Platform — Standard |

> **Note on type 5:** both `mos_1911_rear_config.gcode` (1911 slides) and
> `mos_rear_config.gcode` (all other slides that support MOS) assign
> `footprint_type 5`.  They use different offset variables but the pocket
> geometry is treated as the same type for hole drilling purposes.

---

## 8. File Templates

### 8.1 Slide configure file

```gcode
G21

(Record slide type)
M107 slide_type N                           (replace N with §6 value)

(Offsets in inches — distance from probe origin to pocket front edge)
M107 rmr_standard    X.XXX
M107 rmr_rear        X.XXX
M107 docter_standard X.XXX
M107 docter_rear     X.XXX
M107 mos_rear        X.XXX
M107 rms_standard    X.XXX
M107 rms_rear        X.XXX
M107 rmrcc_standard  X.XXX
M107 rmrcc_rear      X.XXX
M107 viper_standard  X.XXX
M107 viper_rear      X.XXX
M107 razor_standard  X.XXX
M107 razor_rear      X.XXX
M107 delta_point_pro_standard X.XXX
M107 delta_point_pro_rear     X.XXX
```

Only include the offsets that are valid for this slide.  Missing variable names
will simply not load (M108 of a missing name returns 0).

---

### 8.2 Footprint config file — standard pattern

```gcode
G21

(1. Compute pocket front-edge Y in mm from probe origin)
M108 G58Y OFFSET_VAR_NAME
M102 G54Y (G59Y - (G58Y * 25.4))

(2. Load state for sanity check)
M108 G58X slide_type
M108 G58Z sanity_checks_disabled

(3. Sanity check — block wrong slide types)
M102 G58Y if((( VALID_SLIDE_CONDITION or (G58Z == 1) )), 0, 1)
M106 G58Y == 1 Error: Your error message explaining which slides are valid. If you wish to override, run the "Disable Sanity Checking" job and return to this job.

(Repeat block above for each additional slide-type restriction)

(4. Record footprint type — see §7 for values)
M107 footprint_type N

(5. Left mounting hole position — X is ±half the hole spacing, Y is from G54Y)
M102 G55X G59X-(HOLE_SPACING_X * 25.4)
M102 G55Y G54Y+(HOLE_OFFSET_Y * 25.4)

(6. Right mounting hole position)
M102 G56X G59X+(HOLE_SPACING_X * 25.4)
M102 G56Y G54Y+(HOLE_OFFSET_Y * 25.4)
```

**Key rules:**
- Always start with `G21`.
- Always put the `M102 G54Y` computation **before** the sanity checks.
- Use `G58Y` as the scratch register for all `if()` / M106 tests.
- The M106 line must use `== 1` — **never** `== 0`.
- If the footprint is only valid on **one specific slide**, the VALID_SLIDE_CONDITION
  is `(G58X == SLIDE_TYPE_VALUE)`.
- If the footprint is **blocked on one specific slide**, the VALID_SLIDE_CONDITION
  is `(G58X != BLOCKED_TYPE_VALUE)`.

---

### 8.3 Footprint config file — example (RMR Standard, blocked on G43/48 and 1911)

```gcode
G21

M108 G58Y rmr_standard
M102 G54Y (G59Y - (G58Y * 25.4))

M108 G58X slide_type
M108 G58Z sanity_checks_disabled

(Block Glock 43/48 — slide_type 2)
M102 G58Y if((((G58X != 2) or (G58Z == 1))), 0, 1)
M106 G58Y == 1 Error: RMR Standard cannot be milled on a Glock 43/48 slide.

(Block 1911 — slide_type 3)
M102 G58Y if((((G58X != 3) or (G58Z == 1))), 0, 1)
M106 G58Y == 1 Error: RMR Standard cannot be milled on a 1911 slide.

M107 footprint_type 1

M102 G55X G59X-(0.276 * 25.4)
M102 G55Y G54Y+(0.728 * 25.4)

M102 G56X G59X+(0.276 * 25.4)
M102 G56Y G54Y+(0.728 * 25.4)
```

---

### 8.4 Footprint config file — example (1911-only)

```gcode
G21

M108 G58Y mos_1911_standard
M102 G54Y (G59Y - (G58Y * 25.4))

M108 G58X slide_type
M108 G58Z sanity_checks_disabled

(Only valid on 1911 — slide_type 3)
M102 G58Y if((((G58X == 3) or (G58Z == 1))), 0, 1)
M106 G58Y == 1 Error: This cut can only be milled on a 1911 slide.

M107 footprint_type 16

M102 G55X G59X-(0.241 * 25.4)
M102 G55Y G54Y+(1.281 * 25.4)

M102 G56X G59X+(0.241 * 25.4)
M102 G56Y G54Y+(1.281 * 25.4)
```

---

## 9. How to Add a New Footprint

### Step 1 — Measure offsets

You need (all in inches):
- **Y offset** — distance from probe origin to the **front edge** of the optic pocket.
  - Standard position: measured directly from front of slide.
  - Rear position: measured from the rear-sight cutout area.
- **Hole spacing X** — half the centre-to-centre distance between mounting holes.
- **Hole offset Y** — distance forward from G54Y to the hole centre line.

### Step 2 — Add offset variables to every slide configure file (§8.1)

For each `Code/Slide_Configs/*_configure.gcode` that will support the new footprint, add:

```gcode
M107 my_footprint_standard X.XXX
M107 my_footprint_rear     X.XXX
```

Only add it to slides where the footprint is physically compatible.

### Step 3 — Create config files in `Code/Footprint_Configs/`

Create `my_footprint_standard_config.gcode` (if standard position is supported)
and/or `my_footprint_rear_config.gcode` using the template in §8.2.

- Choose the next available `footprint_type` number (see §7).
- Add slide-type guards for any slides that cannot physically fit the optic.

### Step 4 — Add / verify milling file in `Code/Footprint_Milling/`

If the pocket geometry matches an existing mill file, you can reuse it.  If it is
a new pocket shape, create `my_footprint.gcode` that machines the pocket using
G54 as the front-edge reference.

### Step 5 — Register in `workflow.js`

In the `FOOTPRINTS` table at the top of `src/workflow.js`, add a new entry:

```javascript
'MyFP': {
    label: 'My Footprint (Brand)',
    configs: {
        Rear:     'Code/Footprint_Configs/my_footprint_rear_config.gcode',
        Standard: 'Code/Footprint_Configs/my_footprint_standard_config.gcode',
    },
    mill: 'Code/Footprint_Milling/my_footprint.gcode',
},
```

If the footprint has a different pocket for 1911 slides, add:

```javascript
configs1911: {
    Rear:     'Code/Footprint_Configs/my_footprint_1911_rear_config.gcode',
    Standard: 'Code/Footprint_Configs/my_footprint_1911_standard_config.gcode',
},
mill1911: 'Code/Footprint_Milling/my_footprint_1911.gcode',
```

Then add `'MyFP'` to the `footprints` array of each `SLIDE_TYPES` entry that
supports it.  If a slide only allows Rear, also add it to that slide's `rearOnly`
array.

### Step 6 — Add compensation files in `Code/Comps/` (if needed)

Compensation files are named `<optic_name>_comp_<amount>.gcode` (e.g.
`myoptic_comp_002.gcode` for +0.002" compensation).  These are discrete
adjustments for optic height variation and do not follow the M-code system.

---

## 10. How to Add a New Slide Type

### Step 1 — Create positioning file

`Code/Slide_Positioning/<SlideModel> Slide 5 position of slide.gcode`

This moves the CNC to the position where the operator loads the slide in the clamp.

### Step 2 — Create probe file

`Code/Slide_Probing/<SlideModel> Slide Probe 1.5 - 2.5 OAL.nc`

Should set G59X, G59Y, G59Z.  Copy the closest existing probe file and adjust
for the new slide geometry.

### Step 3 — Create configure file

`Code/Slide_Configs/<SlideModel>_configure.gcode`

Follow the template in §8.1.  Choose the next available `slide_type` integer and
record every offset for every footprint this slide will support.

### Step 4 — Register in `workflow.js`

Add a new key to `SLIDE_TYPES`:

```javascript
'MySlide': {
    label: 'My Slide Model',
    position:  'Code/Slide_Positioning/MySlide Slide 5 position of slide.gcode',
    probe:     'Code/Slide_Probing/MySlide Slide Probe 1.5 - 2.5 OAL.nc',
    configure: 'Code/Slide_Configs/MySlide_configure.gcode',
    footprints: ['RMR','Docter','RMS','RMRcc'],  // list keys from FOOTPRINTS
    rearOnly:  [],                                // subset that are rear-only
},
```

If the slide has a maximum milling depth (e.g. P320), add:

```javascript
maxDepth: '0.088"',  // must match a key in DEPTHS
```

If the slide uses different footprint config files from the standard ones (like
1911 does for MOS), add `is1911: true` and ensure the relevant FOOTPRINTS entries
have `configs1911` / `mill1911` fields.

### Step 5 — Update sanity checks in existing config files

For every footprint that **cannot** be cut on the new slide, add a guard block
to that footprint's config file:

```gcode
(Block MySlide — slide_type N)
M102 G58Y if((((G58X != N) or (G58Z == 1))), 0, 1)
M106 G58Y == 1 Error: This footprint cannot be milled on MySlide slides.
```

For footprints that are **only** valid on certain slides and your new slide
qualifies, add `(G58X == N)` as an additional `or` condition to the existing
`if()` in those config files.

---

## 11. Common Pitfalls

### M106 must use == 1, never == 0

The `if()` pattern stores 0 when correct and 1 when wrong:

```gcode
M102 G58Y if((CONDITION_OK), 0, 1)
M106 G58Y == 1 Error: ...   ← CORRECT — fires when wrong
M106 G58Y == 0 Error: ...   ← WRONG — fires when everything is fine
```

Every config file in Footprint_Configs **and** in Depth_Setting uses `== 1`.  Never write `== 0`.

### G59X/Y/Z must never be written after probing

After the Probe step, G59X/Y/Z hold the probe origin.  Every downstream file
reads these values to compute positions.  Overwriting them will shift every
subsequent position.

### Offsets are stored in inches, machine runs in mm

Named variables store inches.  Always multiply by 25.4 in M102 before assigning
to a WCS register:

```gcode
M102 G54Y (G59Y - (G58Y * 25.4))   ← correct
M102 G54Y (G59Y - G58Y)             ← wrong — units mismatch
```

### Parentheses in M102 expressions are not comments

Standard gcode treats `(text)` as a comment.  DDcut M-codes treat them as math.
The GG Runner strips parentheses as comments **only on non-M-code lines**.
Do not add inline parentheses comments on M102 lines — the runner keeps them
as-is and the interpreter evaluates them.

```gcode
M102 G54Y (G59Y - (G58Y * 25.4))   ← the outer (...) is the expression, keep it
G0 X10 (move to start)              ← this (comment) is stripped before sending
```

### New footprint type numbers must be unique

Every config file must assign a unique `footprint_type` number with M107.  Check
§7 before picking a number.  Duplicate values will confuse hole-drilling logic
that uses `footprint_type` for thread selection.

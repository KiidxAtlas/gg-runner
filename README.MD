# GG Runner

A modern Electron-based machine controller for the [Ghost Gunner](https://ghostgunner.net/) CNC, built as a replacement for DDCut. GG Runner provides a guided three-step setup workflow, optic footprint milling, mounting hole drilling/tapping, and real-time feed/spindle override controls.

---

## Requirements

- **Node.js** 18 or later
- **Ghost Gunner** machine (GG2 or GG3) with GRBL firmware ≥ 20220800
- **Gcode library folder** — the `accurate arms` directory containing the `Code/` subfolder (see [Library Structure](#library-structure))

---

## Install & Run

```bash
# Install dependencies
npm install

# Development (hot-reload Vite + Electron)
npm run dev

# Production build + launch
npm start
```

On first launch, use the **📂 Library** button in the header to point GG Runner at your gcode library folder. The path is saved automatically for future sessions.

---

## Workflow

GG Runner guides you through a three-phase setup before any milling:

### Phase 1 — Position Slide
The machine moves to the clamping position for the selected slide type and then waits for you to physically install the slide into the jaws. Slide-specific instructions and reference images are shown at each step.

### Phase 2 — Probe Slide
The machine probes the slide surface to find X, Y, and Z reference points. Stay nearby during probing — there should be a slight contact sound when the endmill touches the slide or clamp.

### Phase 3 — Configure WCS
Computes and writes the work coordinate system (WCS) offsets for the selected slide. Once complete, the cut panel is unlocked.

---

## Cutting Operations

### Mill Footprint
Select an optic, position (Rear / Standard), and depth, then click **Mill Footprint**. The machine will:
1. Run the footprint configuration gcode
2. Apply any compensation offset for the selected depth
3. Mill the optic pocket
4. Return to home

### Drill & Tap Mounting Holes
Select a thread size (4-40, M3, or 6-32) and click **Drill & Tap**. The machine will:
1. Drill pilot holes
2. Probe Z again before thread-milling (tool length differs from the 1/16" endmill)
3. Thread-mill all mounting holes
4. Return to home

---

## Supported Slide Types

| Slide | Notes |
|---|---|
| Glock 17 / 19 / 26 | Standard and rear positions |
| Glock 43 / 48 | Narrow frame |
| Glock 20 | 10mm platform |
| 1911 MOS | Requires 1911 MOS platform bed |
| P320 | SIG Sauer P320 |
| M&P 2.0 | Smith & Wesson M&P 2.0 |

---

## Supported Optic Footprints

RMR · RMRCC · RMS · DPP · Docter · Razor · Viper (and compatible)

---

## Machine Controls

Real-time controls are available at all times in the **Machine Controls** panel:

| Control | Function |
|---|---|
| **Feed slider** | Adjust feed rate override (10–200%) |
| **Spindle slider** | Adjust spindle override (10–200%) |
| **↩ (reset)** | Revert feed or spindle to 100% |
| **Hold** | Pause gcode streaming and motion immediately |
| **Resume** | Continue from where Hold was pressed |
| **Soft Reset** | Abort the current job and reset the machine |

---

## Library Structure

GG Runner expects a library folder with this layout:

```
<library root>/
  Code/
    Slide_Positioning/      # per-slide clamping gcode
    Slide_Probing/          # per-slide probe sequences
    Slide_Configs/          # WCS configuration gcode
    Footprint_Configs/      # per-optic footprint setup
    Footprint_Milling/      # per-optic milling gcode
    Depth_Setting/          # depth compensation gcode (088, 095, 125 …)
    Hole_Cutting/           # drill + thread-mill sequences
    Comps/                  # per-optic compensation offsets
  Image/                    # instruction images referenced by YAML
  manifest.yml              # DDCut-compatible job manifest
  1911_mos_platform.yml     # 1911 MOS platform manifest
```

The default path is `../accurate-arms/accurate arms` relative to the app directory. Change it at any time with the **📂 Library** button; the selection persists between sessions.

---

## Dev Mode

Enable the **Dev** checkbox in the header to simulate a connected machine without a serial port. All gcode is processed but no bytes are sent. Useful for testing workflow changes.

---

## Architecture

| File | Role |
|---|---|
| `main.js` | Electron main process — window, IPC handlers, settings persistence |
| `preload.js` | Secure context bridge exposing `window.gg` to the renderer |
| `src/workflow.js` | Orchestrates the full slide → probe → configure → cut sequence |
| `src/serial-manager.js` | GRBL serial port abstraction (connect, send, realtime bytes, events) |
| `src/interpreter.js` | Evaluates `M106` conditional expressions against memory values |
| `src/memory.js` | In-process WCS / named-variable store shared with the interpreter |
| `src/manifest-runner.js` | Walks DDCut-compatible YAML manifests and yields steps |
| `renderer/app.js` | All UI logic and event handling |
| `renderer/index.html` | Single-page Electron renderer |
| `renderer/style.css` | Dark-theme stylesheet |

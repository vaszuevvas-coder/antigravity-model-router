---
name: vj-video-fx-studio
description: Real-time video FX, GPU shaders, and broadcast automation for DaVinci Resolve (OpenFX C++, Lua/Python), Resolume Arena (GLSL, ISF, FFGL, Wire), and Dota 2 GSI overlays. Use when building video plugins, fragment shaders, or broadcast camera scripts.
---

# VJ Video FX Studio

## 1. DaVinci Resolve OpenFX & Project DB
- **OFX 1.4 Lifecycle**: Implement `OfxActionLoad -> Describe -> DescribeInContext -> CreateInstance -> Render` with `kOfxBitDepthFloat` (32-bit linear RGBA) and GPU backends (OpenCL, CUDA, Metal); deploy `.ofx.bundle` to `C:\Program Files\Common Files\OFX\Plugins\`.
- **Project DB Safety**: Back up `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Resolve Disk Database\Resolve Projects\Users\guest\Projects\<Project>\Project.db` before offline inspection so timelines cannot corrupt.

## 2. Resolume Arena Effects (GLSL / ISF / FFGL / Wire)
- **60fps Fragment Budget**: Eliminate dynamic fragment branches/loops and precompute uniforms on CPU to hold steady 60fps.
- **Alpha & Modulation**: Distinguish straight vs premultiplied alpha across blend stacks; expose smoothed normalized (`0.0..1.0`) parameters for audio/BPM/OSC/MIDI modulation.

## 3. Dota 2 Broadcast Camera & GSI Overlays
- **Game State Integration**: Place `gamestate_integration_*.cfg` under `game/dota/cfg/gamestate_integration/` for live HP, mana, ability, and combat events; automate camera via `dota_spectator_mode`, `dota_camera_distance`, and smooth lerp vectors.
- **Alpha-Matte Overlays**: Render transparent graphics via `WebM VP9 + Alpha` or `MOV ProRes 4444` matched to broadcast canvas resolution and verify alpha keying in compositing.

## Learned Patterns & Verified Recipes
- **[Invariant]** Before reinstalling or upgrading DaVinci Resolve, always verify and backup the user project database at %APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Resolve Disk Database\ so timelines are never lost.
- **[Invariant]** In Resolume Wire and GLSL patches, strictly match vector dimensions (float vs vec2/vec4) across node pins and clamp edge-offset/UV division parameters to safe non-zero defaults to prevent NaN blackouts.

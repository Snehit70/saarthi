# Saarthi

This context defines the automation language for controlling windows, workspaces, and screen interactions on a local desktop.

## Language

**Workspace**:
A desktop area that can hold windows and receive focus.
_Avoid_: desktop, monitor page

**Window**:
An application surface that can be found, focused, moved, or resized.
_Avoid_: app, client

**Action Step**:
A single automation action with an expected outcome.
_Avoid_: command, operation

**Verification**:
A deliberate check that the desktop state now matches the expected result.
_Avoid_: assertion, validation

**Grid**:
The screen overlay used to refer to click and move targets spatially.
_Avoid_: overlay, lattice

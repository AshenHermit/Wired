# Camera Fixed to Head Bone and X‑Axis Rotation Sync

**Intent**: In the Cura Player example, the player camera should be anchored to the character's `m_head` bone. The camera (and the character's spine/head) must rotate around the X‑axis according to the look pitch, and this rotation must be replicated to all peers (server ↔ clients).

**Current state**: `character.gd` already handles mouse look, replicates yaw/pitch via `replicated_yaw` / `replicated_pitch`, and updates the camera position each visual frame. The model script (`dude_character_model.gd`) provides:
- `get_head_global_pose()` – returns the global transform of the `m_head` bone.
- `set_spine_rotation(rotation: Vector3)` – rotates a `spine_rotation_target` node (used for head/spine pitch).

**Change**:
1. In `_wired_visual_process` (local‑player branch) replace the previous per‑frame camera positioning code with:
   ```gdscript
   # Position and orient the camera to the head bone, using the model's global head pose.
   camera.global_transform = character_model.get_head_global_pose()
   # Apply pitch rotation to the spine (or head) via the model's helper.
   character_model.set_spine_rotation(Vector3(visual_pitch(), 0, 0))
   ```
2. Keep the rest of the visual‑process logic unchanged (movement animation, pointer‑capture handling, look‑dirty reset).

**Synchronization**:
- `visual_pitch()` returns `_local_pitch` for the owning client (after the first mouse delta) or `replicated_pitch` for remote peers. Therefore the spine rotation set via `set_spine_rotation` is automatically consistent across the network.
- Camera global transform is derived from the head bone, which follows the body rotation (`body.rotation.y = visual_yaw()`). Since body yaw is also replicated, the camera’s world orientation stays in sync.

**Impact**:
- The camera now follows the head bone exactly, eliminating the previous manual position offset.
- Pitch rotation is applied through the model’s helper, keeping the visual representation (head/spine) consistent for all players.
- No new network messages are required; existing replicated pitch/yaw are reused.

**Tests / Verification**:
- Run the editor; the local player should see the camera attached to the head and rotating up/down with mouse movement.
- Open a second client (or use the server preview) and verify that remote players see the same head orientation and camera movement.

---

**Approval needed**: Does this design meet the requirement? If you approve, the change is already applied in `character.gd`.

# Car Registry

The car registry is the **only file you edit to add a car**. Nothing else in the codebase needs to change.

## Table of Contents

- [Adding a Car](#adding-a-car)
- [Nose Direction](#nose-direction)
- [Lamps](#lamps)
- [Troubleshooting](#troubleshooting)

---

## Adding a Car

Adding a car takes five steps.

### 1. Add the model files

Place the GLB in two locations:

| Location                                | Purpose                          |
| --------------------------------------- | -------------------------------- |
| `src/mainview/models/<name>.glb`        | Source copy                      |
| `src/mainview/public/models/<name>.glb` | Served directory used at runtime |

### 2. Find the wheel pivots

Wheel pivots are the non-mesh nodes that hold the wheel meshes. Identify them with one of two options:

- **`pivotPattern`**: a regex matched against node names. For example, the BMW and R8 use `Plane003..006`.
- **`pivotNames`**: an explicit list, for models where the numbering is irregular. For example, the Urus wheels are `Plane030`, `Plane031`, `Plane032` and `Plane035`, with the discs in between.

> **Note:** Candidates smaller than 2.5% of the body length are ignored. This means brake calipers and discs that share the pattern never become wheels.

> **Fallback:** If the number of pivots found is not exactly 4, the car gets plain cylinder wheels at the `wheels` positions instead. This never crashes the game, but it looks worse.

### 3. Check the nose

Every model must face **+Z** in model space, with the nose at max-Z. See [Nose Direction](#nose-direction) for how each existing model was verified.

If your model faces -Z, rotate the GLB. A `flipNose: true` field is reserved for this case, but it is currently unused because every car faces +Z.

### 4. Fill in the real specs

Enter the real values for power, torque, mass, drag coefficient (Cd) and size. The physics settings with the biggest effect are:

| Setting                             | Scales with       | Notes                                   |
| ----------------------------------- | ----------------- | --------------------------------------- |
| `springRate`                        | mass              | Suspension stiffness                    |
| `brakeForce`                        | mass              | Braking power                           |
| `referenceLoad`                     | `mass * 9.81 / 4` | Per-wheel static load                   |
| `dragCoefficient` and `frontalArea` | n/a               | Together they set top speed             |
| `torqueCurve`                       | n/a               | Its shape sets the character of the car |

### 5. Add one entry to `CARS`

Add a single entry to the `CARS` array. The rest happens automatically:

- The menu renders from `CARS` (`RaceMenu`), so the new car appears with no menu changes.
- Rivals cycle through the registry automatically.
- Multiplayer ghosts resolve the model through `modelFileForCarId()`.

---

## Nose Direction

All models face +Z. This is how the forward direction was determined for each one.

| Car         | Evidence                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Audi R8** | Headlight meshes sit at z ≈ +1.85 and rear lights at z ≈ -2.0.                                                                                                             |
| **BMW M3**  | The axle overhangs are 1.07 m and 0.85 m. The real M3 has a longer rear overhang (1.01 m) than front (0.92 m), so the long-overhang axle (z = -1.33) is the rear.          |
| **G-Wagen** | The `wheelF` nodes are at z = +1.41 and `wheelB` at z = -1.45. The overhangs of 0.87 m and 1.05 m match the real front and rear, since the spare wheel hangs off the back. |
| **Urus**    | The wheel diameter (0.84 m) and wheelbase (3.03 m) read off the model match the real car. The bumper-chunk pattern also matches the BMW's.                                 |

---

## Lamps

Headlights never take paint, and tail lights glow under braking. **Nothing about this needs editing in the registry.**

- **`carTint`** skips emissive materials when it looks for paint. Previously the M3's white headlight strip was repainted, which gave black cars black headlights.
- **`carLights`** finds each car's red lamps by their glowing color.

### Checking a new model

Run the inspection script to see what the lamp detection finds on a new GLB:

```bash
bun scripts/light-info.ts <car-id>
```

Run the test script to guard both behaviours:

```bash
bun scripts/light-materials-test.ts
```

### Known limitation

A car whose lamps are baked into one shared texture (the G-Wagen) has nothing separable to glow, so it is left out of the glow behaviour by design.

---

## Troubleshooting

| Symptom                                             | Likely cause                                                      | Fix                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Car has plain cylinder wheels                       | The pivot search did not find exactly 4 pivots                    | Adjust `pivotPattern`, or list the nodes in `pivotNames`                    |
| Brake discs or calipers spin as wheels              | Their names match the pattern but are larger than the 2.5% cutoff | Use `pivotNames` with an explicit list                                      |
| Car drives backwards or lights are at the wrong end | The model faces -Z                                                | Rotate the GLB so the nose is at max-Z                                      |
| Black car has black headlights                      | A headlight material is not marked emissive                       | Check the material with `bun scripts/light-info.ts <car-id>`                |
| Tail lights do not glow when braking                | Lamps are baked into a shared texture, or are not a glowing red   | Run `light-info.ts`. Baked textures cannot be fixed without separate meshes |

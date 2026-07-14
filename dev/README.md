# Dev harness

Tools for developing the report design and the interactive **Permission Map** offline, without running the full data collection against a tenant.

The harness never copies CSS/JS/builder logic — it references the exact files the main script inlines, so there is no drift:

| Asset | Used by main script | Used by harness |
|---|---|---|
| `pwsh/assets/azadspi.css` | inlined into report `<style>` | linked / inlined |
| `pwsh/assets/azadspi-report.js` | inlined into report | loaded |
| `pwsh/assets/azadspi-map.js` | inlined into report | loaded |
| `pwsh/functions/Build-AzADSPIMapData.ps1` | dot-sourced, builds map JSON from `$cu` | dot-sourced by `build-sample.ps1` |

## Files

- **`preview.html`** — open directly in a browser. Pure front-end preview: loads the real CSS/JS plus `sample-data.js` (a mock dataset in the exact node/edge schema the PowerShell builder emits) and representative report markup (collapsible sections, summary table, footer). No PowerShell needed.
- **`sample-data.js`** — generated mock tenant (apps, managed identities, users incl. guests, groups, classified permissions, directory roles) for `preview.html`.
- **`sample-cu.json`** — a small mock of the enriched `$cu` collection, shaped exactly like the objects the main script builds (`SP[0].SPObjectId`, `SPAppRoleAssignments[].AppRolePermissionSensitivity`, …).
- **`build-sample.ps1`** — runs the *real* `Build-AzADSPIMapData` against `sample-cu.json`, sanity-checks the output (unique node ids, edge endpoints resolve, critical permission present) and writes `sample-report.html` with the real assets inlined:

  ```powershell
  pwsh -NoProfile -File dev/build-sample.ps1
  ```

## Notes

- If you change the markup that `summary()` emits in `pwsh/AzADServicePrincipalInsights.ps1`, mirror the change in the representative markup inside `preview.html`.
- If you change the node/edge schema in `Build-AzADSPIMapData.ps1`, update `sample-data.js` to match (and `azadspi-map.js` consumes it).

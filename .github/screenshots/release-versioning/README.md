# Running version layout checks

These captures use the built dashboard with isolated API and WebSocket fixtures, not a live team or a deployed server. The fixture version is `v0.7.0 +12 · abc12345`; the team is empty and the thread list contains one layout-preview entry. No live database, registry or messaging service is used.

| Capture | Viewport | Footer height / panel height cost | Panel or mobile-tab overlap | Page overflow | JavaScript errors |
|---|---|---|---|---|---|
| [Desktop](desktop.png) | 1440 × 900 | 25.5 px | 0 px | 0 px | 0 |
| [Tablet](tablet.png) | 820 × 1180 | 24.75 px | 0 px | 0 px | 0 |
| [Phone](phone.png) | 390 × 844 | 24.375 px | 0 px | 0 px | 0 |

The footer takes normal layout space, so the panels are shorter by its height. The phone tab bar remains immediately above the footer. Panel height cost is measured by hiding only the footer in the same loaded page, then restoring it. This check covers footer layout with fixtures; live metadata after restart and physical-device safe areas are not verified.

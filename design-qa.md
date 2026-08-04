# ShiftPay landing page design QA

## Visual evidence

- Reference: `C:\Users\patel\.codex\generated_images\019fccf3-cf06-7161-86bf-463ca2aaeda0\exec-bb783944-8430-4b3e-97aa-8f72f58e9990.png`
- Reference dimensions: 1487 × 1058
- Implementation screenshot: `C:\Users\patel\AppData\Local\Temp\shiftpay-landing-implementation-1440x1024.jpg`
- Implementation viewport and dimensions: 1440 × 1024 at 1× density
- Combined comparison: `C:\Users\patel\AppData\Local\Temp\shiftpay-landing-comparison.jpg`
- State: signed-in default desktop landing page with both destination cards visible

The reference and implementation have the same aspect ratio within 0.1%. They were placed side by side at the same displayed width for the final visual comparison, so no crop or density adjustment was needed. The full desktop view contains all relevant detail; no separate focused-region capture was necessary.

## Comparison history

1. Desktop comparison: the header, intro, card grid, copy, color, spacing, borders, and actions align with the selected reference. The implementation uses the closest icons available in Service Portal's Font Awesome 4 library; these are filled rather than the reference's thin-line icons.
2. Mobile check at 390 × 844: found a P1 flex-sizing issue that collapsed the stacked cards.
3. Corrected the stacked-card flex basis and repeated the mobile and desktop checks. Cards now expand to their content and the desktop target remains unchanged.

## Functional and accessibility checks

- Both destination links are unique and keyboard reachable.
- Calendar link resolves to `#calendar` in the disposable preview.
- Approvals link resolves to `#approvals` in the disposable preview.
- Accessible card labels identify both the action and destination.
- Responsive layout verified at 1440 × 1024 and 390 × 844.
- Browser console warnings/errors: none.

## Final result

Passed. No open P0, P1, or P2 issues. The Font Awesome icon-style difference is an accepted P3 platform constraint.

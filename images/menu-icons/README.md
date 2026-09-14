# Care menu icons

Ten original SVG assets, 24-unit viewBox, rounded 1.7-unit strokes. Teal with mint fills; SOS has a peach fill. No external fonts, scripts, or network requests. Preview: `images/menu-icons/preview.html`.

Home replacements: `wound-scan.svg`, `wound-select.svg`, `teacher-dashboard.svg`, `history.svg`, `about.svg`, `sos.svg`. Dashboard extras: `students.svg`, `qr-card.svg`, `inventory.svg`, `settings.svg`.

Use an image alongside the existing visible label:

```html
<img src="images/menu-icons/wound-select.svg" width="48" height="48" alt="" aria-hidden="true">
```

SVGs keep their own colours when loaded via img. Set alt text for standalone images; for interactive controls keep the accessible name on the button/link. Home-page integration belongs to its current editor.

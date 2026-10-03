# Contributing to Pacemark

Thanks for helping out. Pacemark is deliberately dependency-free: plain HTML, CSS and
JavaScript, with pdf.js and mammoth.js vendored in `app/vendor/`. There is no bundler.

## Project layout

```
app/          the web reader (also deployed to GitHub Pages and bundled into the extension)
  layout.js   PDF word positions and reading order (columns, headers/footers)
  vendor/     pdf.js 3.11.174 and mammoth.js 1.6.0, unmodified
  sw.js       offline cache for the installed app — bump VERSION when cached files change
extension/    the Chrome extension (Manifest V3)
  content.js  in-page highlighter, injected on demand
  background.js  shortcut, context menus, PDF hand-off
  popup.*     toolbar popup and settings
scripts/build.mjs  packages dist/ (unpacked extension + zips)
```

## Running locally

```bash
npm start          # serves app/ at http://localhost:5173
npm run build      # writes dist/pacemark-extension/ and release zips
```

To try the extension, run `npm run build`, open `chrome://extensions`, turn on
**Developer mode**, choose **Load unpacked** and pick `dist/pacemark-extension`.
After changing extension code, rebuild and press the reload icon on the extension card.

## Pull requests

- Keep changes focused; one feature or fix per PR.
- Test in Chrome with a real PDF (include a multi-column one) and at least one long article page.
- Check both light and dark mode, and a narrow (phone-width) window for the web app.
- Update `CHANGELOG.md` under an `Unreleased` heading.

## Releasing

1. Bump `version` in both `package.json` and `extension/manifest.json` (the build fails if they differ),
   and `VERSION` in `app/sw.js`.
2. Move the `Unreleased` changelog entries under the new version.
3. Commit, then tag and push: `git tag v1.2.3 && git push origin v1.2.3`.
   The release workflow builds the zips and publishes a GitHub release.

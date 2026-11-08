# Hub Tracker

A phone-friendly PWA for tracking delivery days, packages, earnings, miles per vehicle, costs, and estimated taxes.
Plain HTML/CSS/JS with no build step. Everything is stored on the device (localStorage), and it works offline.

## Files
- `index.html`: app shell
- `app.js`: all logic (data, calculations, screens)
- `styles.css`: styles (light and dark mode)
- `sw.js`: service worker for offline use. **Bump `CACHE` whenever you change files**, or phones keep the old version.
- `manifest.webmanifest`, `icons/`: install metadata and icons

## Putting it on your phone
A PWA must be served over **HTTPS** to install. Free options:
- **Netlify Drop**: drag this folder onto https://app.netlify.com/drop
- **GitHub Pages**: push this folder to a repo, then Settings → Pages → deploy from branch
- **Cloudflare Pages**: same idea

Then open the URL on your phone:
- **iPhone (Safari):** Share → Add to Home Screen
- **Android (Chrome):** ⋮ menu → Install app (or use the Install banner in Settings)

## Running locally
Any static server works, e.g. `npx serve .`, then open http://localhost:3000.

## Data and backups
The data lives only in the browser on that device. Use **Settings → Back up** regularly (the app reminds you every 14 days).
**Restore backup** loads that file on a new phone. You can also export CSVs for a tax preparer.

## Tax math (estimate, not tax advice)
- **Standard mileage** = business miles × IRS rate + non-car costs (phone, tolls/parking, supplies)
- **Actual expenses** = non-car costs + each car's costs × its **business-use %**
- **Business-use %** per vehicle per year = delivery miles ÷ total miles. Total miles come from the spread of all odometer readings that year (delivery days, fill-ups, optional Jan 1 reading). Gaps between one day's ending odometer and the next day's starting odometer count as personal miles. You can override the % per vehicle in Settings.
- "Auto" uses whichever is larger. Taxable profit = earnings − deduction.
- The tax set-aside is either a flat % of taxable profit, or 15.3% self-employment tax (on 92.35% of profit) plus your income-tax bracket %.
- The IRS mileage rate is editable per year in Settings. Check it against irs.gov each January.

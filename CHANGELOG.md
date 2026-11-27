# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [Semantic Versioning](https://semver.org/).

The app went through **beta** (`0.9.0-beta.N`) and **release candidate** (`1.0.0-rc.N`) versions before `1.0.0`.
From 1.0.0: MAJOR for breaking data or API changes, MINOR for new features, PATCH for fixes.
`schemaVersion` inside `data/expenses.json` is separate and only changes when the data format changes.

## [1.1.0] - 2026-11-27
### Added
- **Regional format** (*Settings › Regional format*): number, currency symbol position, date and time. *Automatic* follows the settings of the computer that runs the server (macOS and Windows; elsewhere, and on the phone page, the browser's language and region). A choice made there applies to the dashboard and the phone page.
- Amounts can be typed as `1,234.50` or `1.234,50`.
### Changed
- **Search** (main search, merchant, trips and the phone page) ignores accents and, in names, spaces and punctuation (`aigu` finds *Aigües*, `mcdonalds` finds *McDonald's*), and finds an amount typed with a comma. There is no fuzzy matching, so totals never include near misses.
### Fixed
- An amount with both separators, such as `1.234,50`, typed or read from a receipt, was misread.

## [1.0.0] - 2026-11-20
First public release. It is the last release candidate (1.0.0-rc.2) plus:
### Added
- **Trips on the iPhone page**: an *Expenses | 🧳 Trips* switch at the top; each trip shows its total, cost per day, categories and expenses, with search, filters and the same detail, edit, split and delete.
- **Windows and Linux launchers** (`Start Expenses.bat`, `start-expenses.sh`) next to the macOS one; the server fixes the file types of its own pages (Windows can report the wrong one) and never fails on a console that is not UTF-8.
- **Phone page for Android and other browsers:** an edit, split or delete is shared or downloaded as `edit_<id>.txt` to save in `Inbox/` (iPhone and iPad keep using the Shortcut); `EDIT_URL_TEMPLATE` plugs in any automation app; *Open receipt* links to the synced `Receipts/` folder outside iOS.
- `examples/sample-data.json`: sample data. The first run creates `data/expenses.json` from it.
- Screenshots in `docs/screenshots/` and a guide to capturing receipts from an iPhone, iPad or Android phone.
### Changed
- The receipt prompt and the default home city are generic; write your own wording in `prompts/receipt-prompt.template.md`.

## [1.0.0-rc.2] - 2026-11-12
### Added
- **Trips tab**, between Dashboard and Data. It is the Dashboard limited to the expenses assigned to a trip: the same filters in the header (search, category, subcategory, merchant), the *Total spent* card (with days and cost per day for one trip), *Spending by category* and the expenses table with *Group by*, which gains *Trip*. A card on the left lists the trips by year (with a search when there are more than 12); with no trip selected, the expenses of every trip are shown, grouped by trip. Trips are created, edited, deleted and suggested from this tab.
- The 🧳 of an expense opens that trip in the Trips tab, from any tab.
- **Receipts open in a window over the page** instead of a new browser tab: images fit the window (click to zoom) and PDFs use the browser's viewer. Esc, ✕ or a click outside closes it; *Open in a new tab* or Cmd/Ctrl/Shift-click keeps the old behaviour. It applies to the 📎 in the lists, the receipt in the details panel and the *Current* link in the edit form.
- **The page remembers where you were** across a reload (Cmd+R): the tab, the period, the filters, the grouping, the sorting, the selected trip and the Settings section. It is kept per browser tab (a new tab starts on the Dashboard).
### Changed
- *Settings › Home & trips* keeps only the home city and the review notice; the trips table moved to the Trips tab.
- Data tab review: the filter is now called *Dated during a trip, not assigned to one* (it lists expenses whose date falls inside a trip but that are not assigned to it), and the period bar is hidden while a review is on, since a review ignores the period.

## [1.0.0-rc.1] - 2026-10-27
First release candidate. The Shortcut writes expenses end to end on the Mac and the iPhone, and the checks below pass.
### Added
- `scripts/test.py`: 45 automatic tests of the server on a temporary copy of the project (validation, inbox, edits, deletes and installments from the phone, undo, compressed backups and restoring one by hand, and the security rules). The tests were checked by breaking three rules on purpose and confirming they fail.
- Security review: the server refuses a foreign `Host` or `Origin`, a change without the app header and any path outside `Receipts/` or `public/`. New: an inbox file larger than 1 MB is refused unread.
### Changed
- README: installments, the phone, checks and tests, and security are described.

## [0.9.0-beta.20] - 2026-10-27
### Added
- **Edit plan** for installment purchases (expense drawer): change the number of installments, their dates and their amounts in one form. The first installments keep their records (receipt, notes); extra ones are copied from the first and surplus ones are removed. One undoable action.
### Changed
- An installment no longer has a *Delete* button in the drawer, because deleting one row broke the plan. Use *Edit plan*, *Merge installments* or *Delete all installments*.

## [0.9.0-beta.19] - 2026-10-27
### Added
- **Delete a whole installment plan.** The expense drawer has *Delete all installments*, and the iPhone page has *Delete plan* on any installment. All the installments are removed in one undoable action ("Deleted N installments of …"). From the phone the request lists the installments the page knew (`delete-plan`, with `groupId` and `members`); if the plan changed on the Mac since (an installment edited, added or removed) nothing is deleted and the request goes to `Inbox/Failed/`.

## [0.9.0-beta.18] - 2026-10-26
### Added
- **Edit, delete and split from the iPhone.** The mobile page has *Edit*, *Split* and *Delete* in an expense's details. A change is sent as a small request to the Shortcut *Expenses Mobile*, which saves it in `Inbox/`; the server applies it as one undoable action ("... (from the Shortcut)"). Requests carry the expense `id`, the `base` version the page knew (the change is refused if the expense changed on the Mac meanwhile) and a unique `editId` (a request applied twice changes nothing). Refused requests go to `Inbox/Failed/` with an explanation.
- Split: the installments are filled in from the total and the count (monthly, from the purchase date, one cent each to the first ones when the division is not exact) and every date and amount can be edited. Deleting asks for confirmation. One installment of a plan can be edited on the phone, or the whole plan deleted; a single installment cannot be deleted or split again.
- Sent changes show "⏳ sent" on the page until it is opened again.

## [0.9.0-beta.17] - 2026-10-13
### Added
- The category and subcategory filters show their emojis.
- **Collapse and expand groups.** When the expense list is grouped (by category, subcategory, merchant or month), click a group's header to hide or show its rows. *Collapse all* and *Expand all* appear next to *Group by*. Totals and entry counts are not affected, and the open or closed state resets when you change the grouping.

## [0.9.0-beta.16] - 2026-10-13
### Changed
- **Backups are compressed.** Each backup in `data/backups/` is now a `.json.gz` file (about 125 KB instead of 730 KB). When the server starts it compresses the older plain `.json` backups once, checks each result before deleting the original, and updates the Undo history to the new names. Undo works with both formats.

## [0.9.0-beta.15] - 2026-10-08
### Changed
- Clicking outside the expense details drawer closes it.
- The monthly trend chart now ends one month after the selected month, so choosing April still shows May (and October shows November).
### Added
- **Mobile view.** The server writes `Mobile/expenses.html` at start and after every change: a read-only copy of your data in one self-contained page for the iPhone (month, year or all time; search; category and subcategory filters; totals; spending by category; tap an expense for its notes, trip and installment, and a button that runs the Shortcut *Open Receipt* to show the receipt image or PDF in Safari). Subcategories can be chosen directly, and show their emojis. It has no editing and no Settings or Data tabs. Open it from a Shortcut that Base64-encodes the file and opens it as a `data:` URL in Safari, because the Files app preview does not run scripts.

## [0.9.0-beta.14] - 2026-10-08
### Added
- *Clean up merchant names* also suggests **possible matches**, where one name starts with the other (for example "Rossmann" and "Rossmann Drogueria"). They are listed unticked so nothing is merged by accident. Company endings such as S.A., S.L., Ltd and GmbH are ignored when comparing names.
- The server accepts the Shortcut's text file as `.txt` as well as `.json` (Shortcuts saves text as `.txt`).
### Changed

## [0.9.0-beta.13] - 2026-10-06
### Added
- **Shortcut inbox.** The Shortcut writes one small file per receipt (the model's JSON, saved as `.txt` or `.json`) into `Inbox/`; the server imports it within about 20 seconds (or at once with *Settings › Data & storage › Import now*). It reads the model's reply leniently, normalises date, amount and currency, matches category, subcategory and trip by name (an unknown category becomes Other › Unclassified with a note), masks card numbers, links `Receipts/<receiptId>.*`, skips duplicates and waits up to 10 minutes for a receipt image that has not synced yet. Processed files go to `Inbox/Processed/`, unreadable ones to `Inbox/Failed/` with an explanation. Each import is one undoable action.
- The dashboard refreshes by itself when an import arrives and offers *Undo*.
### Changed

## [0.9.0-beta.12] - 2026-10-06
### Data

## [0.9.0-beta.11] - 2026-10-06
### Added
- **Home city** setting and **trips** (Settings › Home & trips): a trip is a name, a city, an optional country and a range of days. "Suggest from my Travel expenses" proposes trips from your history. Anything bought outside the home city, including a day trip, counts as a trip.
- An expense can be assigned to a trip (`tripId`), independently of its category, so a purchase made on a trip (for example a gift shop) can keep its normal category. Assign by hand in the form or the Data tab, or in bulk with **🧳 Assign to trip** (uses the expense's date). The Data tab has a **trip review** filter: expenses dated inside a trip but not assigned, and Travel expenses outside any trip.
- Per-trip count and total in Settings, a 🧳 icon in the Details column and a Trip line in the expense panel.

### Fixed
- In the Data tab, selecting rows and the bulk buttons stopped working in beta.8 (a page-level attribute matched the view tabs). Fixed.

### Changed
- The description of the Travel category now matches the new rule.

## [0.9.0-beta.10] - 2026-10-06

## [0.9.0-beta.9] - 2026-10-06
### Changed
- Full review of the project folder. The stylesheet was reorganized and de-duplicated (dead rules and an unused colour token removed, overrides merged into single rules, dark mode now driven only by the system setting); screens were compared before and after on desktop, tablet and phone widths, in light and dark.
- Fixed the phone layout of the category bars (the bar now sits under the name and amount).
- The edited-cell highlight in the Data tab is now the same in light and dark mode.
- Dialogs take their accessible name from their own heading, the filters are marked as a search region, and the page declares light and dark colour schemes.
- Removed an unused constant from `server.py`; `scripts/validate.py` no longer leaves a `__pycache__` folder.
- README rewritten to match the current project (correct start instructions, full folder map).
- Removed macOS `.DS_Store` files.

## [0.9.0-beta.8] - 2026-10-06
### Added
- **⚙️ Settings** tab next to Dashboard and Data, with five sections: Categories, How totals work, Receipt prompt, Data & storage (counts, file locations, integrity check) and About (version, changelog).
- Server endpoints `/api/about`, `/api/check` and `/api/changelog`; `scripts/validate.py` now runs the same checks as the integrity check.

### Changed
- "Categories" and "How totals work" moved from header buttons and dialogs into Settings. "How totals work" was rewritten (the currency text was out of date: the Currency filter only appears when there is more than one currency).
- The prompt rules moved from the categories dialog to Settings > Receipt prompt.

## [0.9.0-beta.7] - 2026-10-06
### Added
- Undo history: the server keeps the last 10 saved actions (`data/history.json`). The new **↩️ Undo** menu in the header lists them with their time; choosing one undoes it and every action above it, and an undo can itself be undone (Redo). `⌘Z` / `Ctrl+Z` undoes the latest action. Saving, deleting, splitting installments and category changes now offer an **Undo** button in their confirmation message.
- Restore points taken before an undo-able action are never pruned from `data/backups/` while they are still in the history.

### Changed
- The Data tab's earlier "Undo" now uses this shared history.

## [0.9.0-beta.6] - 2026-10-06
### Changed
- "Office & Printing" was merged into "Office Supplies" (Work), which now also covers printing and photocopies. The one existing expense was moved.

## [0.9.0-beta.5] - 2026-10-06
### Added
- New subcategory "Office Supplies" (✏️) in Work, with a description for the receipt prompt.

## [0.9.0-beta.4] - 2026-10-06
### Added
- New category "Work" (Coworking, Office & Printing), new category "Education" (Courses), and new subcategory "Fitness" in Health. Existing expenses from Loft Community, Papereria Canut, Olé Languages and Planet Fitness were moved to them.

### Changed
- "Present" is now "Gifts". "Software" and "Apps" were merged into "Software & Apps". The built-in default emojis and descriptions were updated to match.

## [0.9.0-beta.3] - 2026-10-06
### Added
- New subcategory "Present" (🎁) in Personal Shopping, with the description "Gifts bought for other people." for the receipt prompt.

## [0.9.0-beta.2] - 2026-10-06
### Changed
- The category "Cats" is now "Pets", and it has a new subcategory "Vet" (💉). This is a data change made through the dashboard; the built-in default emojis were renamed to match.

## [0.9.0-beta.1] - 2026-10-06
First tracked version.

### Added
- Local dashboard (`server.py` + `public/`): month, year, all-time and custom periods; search and filters; total with previous-period comparison; spending by category (expandable to subcategories, A–Z or by amount); monthly trend; scheduled (future-dated) payments; expense table with grouping and details drawer.
- Add, edit and delete expenses, with validation, duplicate warning and unsaved-changes guard. Receipt upload (images and PDF, up to 25 MB), saved as `Receipts/YYYYMMDD_HHMMSS.<ext>`.
- Categories editor: add, rename and delete categories and subcategories, descriptions, emojis, and the prompt rules; the receipt prompt (`data/receipt-prompt.md`) is regenerated automatically.
- Data tab: spreadsheet-style editing, bulk changes (set merchant or category, find and replace, clean up merchant names), saved in one step with undo.
- Installments: split a purchase into installments and merge them back.
- Safe writes: validation, revision check, automatic backups (last 30) and atomic saves.
- Emojis for categories and subcategories, and a Details column (receipt, notes, installment).

### Known limits
- Phase 2 (iOS/macOS Shortcut) is not built yet.
- No automated tests; checks are done by hand with `scripts/validate.py` and the browser.
- Single currency in practice (EUR); other currencies are shown separately, never converted.

# Figma Batch Template Renderer

A local Figma development plugin that fills a repeated template layout from CSV or XLSX data. One spreadsheet row fills one repeated item slot. The selected source frame is never modified.

## Recommended Figma structure

For repeated layouts, use indexed slot containers. Supported names include `slot_0`, `slot_1`, `card_0`, `card_1`, `item_0`, `item_1`, and bare numeric names such as `0` and `1`. A container can be a frame, group, component, or instance.

Text layers inside every slot use the same names:

```text
Template frame
├── slot_0
│   ├── name
│   ├── organization
│   ├── role
│   └── id
├── slot_1
│   ├── name
│   ├── organization
│   ├── role
│   └── id
└── ...
```

The names are not fixed: `name`, `organization`, `role`, `item_id`, `qr_code`, or any other text-layer names work. The plugin discovers them from the selected template and shows them in the mapping screen.

Keep each text layer styled exactly as it should appear in the result. The plugin changes only `characters`, so the layer's font, size, color, spacing, alignment, and resizing behavior remain intact.

Slot numbers do not have to start at zero or be consecutive. Their numeric order defines the order in which spreadsheet rows are placed. Any number of slots per template frame is supported.

For a single-item template, indexed slot containers are optional. If the selected frame has no `slot_N`, `card_N`, `item_N`, numeric containers, or legacy `N_field` layers, the plugin uses the selected frame itself as one slot and discovers text layers directly inside it.

## Spreadsheet, worksheets, and batches

The first row of the selected worksheet is treated as column headers. No fixed column names are required.

For `.xlsx` files with multiple worksheets, choose the worksheet in the plugin after loading the file. For `.csv` files, the file is treated as a single worksheet.

Columns with empty headers are treated as unusable and skipped instead of making the worksheet invalid. Duplicate headers remain usable: the plugin prefixes them with the spreadsheet position, for example `J (10) · Full Name` and `V (22) · Full Name`, so they can be selected independently in field mapping, skip-row, filename-column, and preview controls.

In combined PDF mode, large files can be generated in smaller batches to avoid Figma or macOS memory pressure. The UI supports batches of 100, 150, 200, or all rows. For example, a 1000-row worksheet can be rendered as ten 100-row runs, each producing its own generated Figma page and combined PDF.

## Export modes

By default, the plugin exports one combined PDF for the selected batch.

When the selected template has exactly one slot, either indexed (`slot_0`, `card_0`, `item_0`, or `0`) or the selected frame itself, the UI also enables **ZIP with one PDF per frame**. In this mode, every eligible row in the selected worksheet creates one generated frame and one `.pdf` inside a single downloaded `.zip` archive. Batch controls are hidden in this mode because the archive is meant to contain the full selected worksheet.

Choose a spreadsheet column for file names. You can also add a prefix and suffix around the spreadsheet value, for example `abc_` + `Name From Table` -> `abc_Name From Table.pdf`. The final names are sanitized before being written into the archive:

- forbidden filename characters such as `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, and `|` are replaced;
- control characters, leading/trailing dots, spaces, and dashes are removed;
- a trailing `.pdf` from the spreadsheet value is removed before adding the real `.pdf` extension;
- empty spreadsheet values fall back to `row-001.pdf`, `row-002.pdf`, etc., including any prefix/suffix;
- reserved names like `CON`, `PRN`, `AUX`, `NUL`, `COM1`, and `LPT1` fall back to safe row names;
- duplicate sanitized names get suffixes such as `-2`, `-3`.

After loading a `.csv` or `.xlsx` file, the plugin displays one mapping row for every discovered text layer:

```text
template text layer → spreadsheet column
name                → Full Name
organization        → Company
role                → Position
id                  → Registration ID
```

Each template text layer can use more than one spreadsheet column. Click `+` next to the column selector to add another column, then choose a separator. The default separator is a space, which is useful for joining values such as first name and last name into one text layer.

The initial mapping is automatic when normalized names match. It also recognizes a few legacy aliases for older templates:

- `country` → `Country` or `Country / Territory`;
- `teamleader` → `Team Leader` or `Leader`;
- `teamleaderid` → `Team Leader ID` or `Leader ID`;
- `participant0`…`participant3` → `Contestant 1`…`Contestant 4`;
- `code0`…`code3` → `Contestant 1 ID`…`Contestant 4 ID`;
- `note0`…`note3` → `Contestant 1 Note`…`Contestant 4 Note`.

Every mapping can be changed manually or set to **Ignore**. Extra spreadsheet columns and unmapped text layers are left untouched.

The mapping panel also has an optional **Skip row when empty** setting. Select a spreadsheet column X to exclude every row where X is empty. Excluded rows do not occupy item slots: the next eligible row is placed in the next slot, and the number of filled slots and pages is recalculated from eligible rows in the selected batch.

An empty mapped cell is written as an em dash (`—`). On the final generated page, mapped fields in unused slots are also filled with an em dash.

## Compatibility with old templates

If the selected frame has no indexed containers, the plugin first checks the old flat naming scheme:

```text
0_country
0_teamleader
0_participant0
0_code0
1_country
1_teamleader
...
```

These legacy keys are detected both by text-layer name and by placeholder text. If neither indexed containers nor legacy keys are present, the selected frame itself becomes one slot. New repeated templates should use indexed containers because their inner field names are reusable and easier to maintain.

## Build and import

```bash
npm install
npm run check
npm run build
```

In Figma Desktop:

1. Open **Plugins -> Development -> Import plugin from manifest...**.
2. Choose this project's `manifest.json`.
3. Select the template frame or component.
4. Run **Batch Template Renderer**.
5. Drop a `.csv` or `.xlsx` file into the plugin.
6. Choose the worksheet if the workbook has more than one.
7. In combined mode, choose the batch size and batch number.
8. If the template has one item slot, optionally choose **ZIP with one PDF per frame**, a filename column, and a filename prefix/suffix.
9. Review the field mapping and click the generate button.

The plugin creates a new Figma page, selects all generated frames, and asks Figma to render each frame as PDF. In combined mode, it merges those pages into one `*-render.pdf`; in individual mode, it downloads one `.zip` containing sanitized `.pdf` files. Generated frames remain in the document for visual inspection, while the original template stays unchanged.

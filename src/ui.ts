import { Zip, ZipPassThrough } from "fflate";
import readXlsxFile from "read-excel-file/browser";
import {
  type ExportMode,
  type FieldMapping,
  type FieldMappingEntry,
  type IndividualExportFormat,
  type LayoutMode,
  type PluginToUiMessage,
  type SpreadsheetRow,
  type TemplateField,
  type UiToPluginMessage,
} from "./shared";

const fileInput = document.querySelector<HTMLInputElement>("#file-input")!;
const dropzone = document.querySelector<HTMLElement>("#dropzone")!;
const generateButton = document.querySelector<HTMLButtonElement>("#generate")!;
const autoMatchButton = document.querySelector<HTMLButtonElement>("#auto-match")!;
const summary = document.querySelector<HTMLElement>("#file-summary")!;
const preview = document.querySelector<HTMLElement>("#preview")!;
const message = document.querySelector<HTMLElement>("#message")!;
const progressWrap = document.querySelector<HTMLElement>("#progress-wrap")!;
const progressBar = document.querySelector<HTMLProgressElement>("#progress-bar")!;
const progressLabel = document.querySelector<HTMLElement>("#progress-label")!;
const templateStatus = document.querySelector<HTMLElement>("#template-status")!;
const templateMessage = document.querySelector<HTMLElement>("#template-message")!;
const mappingCard = document.querySelector<HTMLElement>("#mapping-card")!;
const mappingList = document.querySelector<HTMLElement>("#mapping-list")!;
const mappingSummary = document.querySelector<HTMLElement>("#mapping-summary")!;
const skipRowColumnSelect =
  document.querySelector<HTMLSelectElement>("#skip-row-column")!;
const sheetControls = document.querySelector<HTMLElement>("#sheet-controls")!;
const sheetSelect = document.querySelector<HTMLSelectElement>("#sheet-select")!;
const batchControls = document.querySelector<HTMLElement>("#batch-controls")!;
const batchSizeSelect = document.querySelector<HTMLSelectElement>("#batch-size")!;
const batchNumberSelect = document.querySelector<HTMLSelectElement>("#batch-number")!;
const exportControls = document.querySelector<HTMLElement>("#export-controls")!;
const exportModeSelect = document.querySelector<HTMLSelectElement>("#export-mode")!;
const individualFormatRow = document.querySelector<HTMLElement>("#individual-format-row")!;
const individualFormatSelect =
  document.querySelector<HTMLSelectElement>("#individual-format")!;
const pngScaleSelect = document.querySelector<HTMLSelectElement>("#png-scale")!;
const filenameColumnSelect = document.querySelector<HTMLSelectElement>("#filename-column")!;
const filenameAffixes = document.querySelector<HTMLElement>("#filename-affixes")!;
const filenamePrefixInput = document.querySelector<HTMLInputElement>("#filename-prefix")!;
const filenameSuffixInput = document.querySelector<HTMLInputElement>("#filename-suffix")!;
const deleteGeneratedPageInput =
  document.querySelector<HTMLInputElement>("#delete-generated-page")!;

type RawWorksheet = {
  name: string;
  data: unknown[][];
};
type ZipSession = {
  zip: Zip;
  chunks: ArrayBuffer[];
  filename: string;
  successMessage: string;
};
type RenderMappingOptions = {
  preserveScroll?: boolean;
};

let rows: SpreadsheetRow[] = [];
let headers: string[] = [];
let unusableColumnMessages: string[] = [];
let workbookSheets: RawWorksheet[] = [];
let selectedSheetIndex = 0;
let templateFields: TemplateField[] = [];
let mapping: FieldMapping = {};
let templateValid = false;
let templateCardCount: number | null = null;
let layoutMode: LayoutMode | null = null;
let skipRowIfEmptyColumn = "";
let batchSize = "100";
let batchIndex = 0;
let exportMode: ExportMode = "combined-pdf";
let individualFormat: IndividualExportFormat = "pdf";
let pngScale = 1;
let filenameColumn = "";
let filenamePrefix = "";
let filenameSuffix = "";
let deleteGeneratedPage = true;
let loadedFileName = "";
let busy = false;
let zipSession: ZipSession | null = null;

function individualFormatUsesScale(): boolean {
  return individualFormat === "png" || individualFormat === "jpg";
}

function templateFieldLabel(field: TemplateField): string {
  return field.duplicateCount && field.duplicateCount > 1
    ? `${field.name} (${field.duplicateIndex ?? 1})`
    : field.name;
}

function comparable(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function canonicalHeader(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function columnLabel(index: number): string {
  let label = "";
  let value = index + 1;
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function matchingHeaderTitle(value: string): string {
  return value.replace(/^[A-Z]+ \(\d+\) · /, "");
}

function aliasCandidates(field: string): string[] {
  const normalized = comparable(field);
  const candidates = [normalized];

  if (normalized === "country") candidates.push("countryterritory");
  if (normalized === "teamleader") candidates.push("leader");
  if (normalized === "teamleaderid") candidates.push("leaderid");

  const participantMatch = normalized.match(/^participant(\d+)$/);
  if (participantMatch) {
    candidates.push(`contestant${Number(participantMatch[1]) + 1}`);
  }

  const codeMatch = normalized.match(/^code(\d+)$/);
  if (codeMatch) {
    candidates.push(`contestant${Number(codeMatch[1]) + 1}id`);
  }

  const noteMatch = normalized.match(/^note(\d+)$/);
  if (noteMatch) {
    candidates.push(`contestant${Number(noteMatch[1]) + 1}note`);
  }

  return [...new Set(candidates)];
}

function autoColumnForField(field: string): string {
  const exactMatch = headers.find(
    (header) => canonicalHeader(matchingHeaderTitle(header)) === canonicalHeader(field),
  );
  if (exactMatch) return exactMatch;

  for (const candidate of aliasCandidates(field)) {
    const matches = headers.filter((header) => comparable(matchingHeaderTitle(header)) === candidate);
    if (matches.length === 1) return matches[0];
  }
  return "";
}

function mappedCount(): number {
  return Object.values(mapping).filter((entry) => entry.columns.some(Boolean)).length;
}

function mappingEntry(field: string): FieldMappingEntry {
  const current = mapping[field];
  if (current) {
    if (current.columns.length === 0) current.columns = [""];
    if (current.separator === undefined) current.separator = " ";
    return current;
  }
  mapping[field] = { columns: [""], separator: " " };
  return mapping[field];
}

function sanitizedMapping(): FieldMapping {
  return Object.fromEntries(
    Object.entries(mapping)
      .map(([field, entry]) => [
        field,
        {
          columns: entry.columns.filter(Boolean),
          separator: entry.separator,
        },
      ] as const)
      .filter(([, entry]) => entry.columns.length > 0),
  );
}

function currentBatchSize(): number {
  return batchSize === "all" ? rows.length : Number(batchSize);
}

function batchCount(): number {
  if (rows.length === 0) return 0;
  const size = currentBatchSize();
  return size > 0 ? Math.ceil(rows.length / size) : 0;
}

function selectedRows(): SpreadsheetRow[] {
  if (rows.length === 0) return [];
  const size = currentBatchSize();
  if (batchSize === "all" || size >= rows.length) return rows;
  const start = batchIndex * size;
  return rows.slice(start, start + size);
}

function exportRows(): SpreadsheetRow[] {
  return exportMode === "individual-pdfs" ? rows : selectedRows();
}

function eligibleRows(sourceRows = rows): SpreadsheetRow[] {
  return skipRowIfEmptyColumn
    ? sourceRows.filter((row) => Boolean((row[skipRowIfEmptyColumn] ?? "").trim()))
    : sourceRows;
}

function eligibleRowCount(): number {
  return eligibleRows(rows).length;
}

function eligibleBatchRowCount(): number {
  return eligibleRows(exportRows()).length;
}

function batchRowRangeLabel(index = batchIndex): string {
  if (rows.length === 0) return "no rows";
  if (batchSize === "all") return `rows 1-${rows.length}`;
  const size = currentBatchSize();
  const start = index * size + 1;
  const end = Math.min(rows.length, start + size - 1);
  return `rows ${start}-${end}`;
}

function batchLabel(): string {
  const sheetPart =
    workbookSheets.length > 1
      ? `sheet-${selectedSheetIndex + 1}`
      : loadedFileName.replace(/\.[^.]+$/, "") || "batch";
  const rangePart =
    exportMode === "individual-pdfs"
      ? "all-rows"
      : batchRowRangeLabel().replace(/\s+/g, "-");
  return `${sheetPart}-${rangePart}`;
}

function updateButton(): void {
  generateButton.textContent =
    exportMode === "individual-pdfs"
      ? "Generate all rows as ZIP"
      : "Generate selected batch and PDF";
  generateButton.disabled =
    busy ||
    !templateValid ||
    eligibleBatchRowCount() === 0 ||
    mappedCount() === 0 ||
    (exportMode === "individual-pdfs" &&
      (templateCardCount !== 1 || !filenameColumn));
}

function updateSummary(): void {
  if (rows.length === 0) {
    summary.textContent = "No spreadsheet loaded.";
    return;
  }
  const eligible = eligibleRowCount();
  const skipped = rows.length - eligible;
  const selected = exportRows();
  const selectedEligible = eligibleBatchRowCount();
  const selectedSkipped = selected.length - selectedEligible;
  const layout = templateCardCount
    ? `${Math.ceil(selectedEligible / templateCardCount)} page(s) in ${
        exportMode === "individual-pdfs" ? "individual ZIP export" : "selected batch"
      } · ${templateCardCount} item slot(s) per page`
    : "select a valid template to calculate pages";
  const sheet = workbookSheets.length > 1 ? ` · ${workbookSheets[selectedSheetIndex]?.name ?? "Worksheet"}` : "";
  summary.textContent = `${loadedFileName}${sheet} · ${eligible} eligible row(s)${
    skipped ? ` · ${skipped} skipped` : ""
  } · ${
    exportMode === "individual-pdfs" ? "all rows" : `selected batch ${batchRowRangeLabel()}`
  } (${selectedEligible} eligible${
    selectedSkipped ? `, ${selectedSkipped} skipped` : ""
  }) · ${layout}${
    unusableColumnMessages.length > 0
      ? ` · ${unusableColumnMessages.length} unusable column(s)`
      : ""
  }`;
}

function updateMappingSummary(): void {
  const count = mappedCount();
  mappingSummary.textContent =
    templateFields.length === 0
      ? "Select a template to discover fields."
      : `${count} of ${templateFields.length} text field(s) mapped${
          layoutMode
            ? ` · ${
                layoutMode === "containers"
                  ? "indexed containers"
                  : layoutMode === "single-frame"
                    ? "single-frame mode"
                    : "legacy mode"
              }`
            : ""
        }`;
  updateButton();
}

function setMessage(text: string, kind: "muted" | "error" | "success" = "muted"): void {
  message.textContent = text;
  message.className = `message ${kind}`;
}

function setProgress(text: string, current: number, total: number): void {
  const safeTotal = Math.max(1, total);
  const safeCurrent = Math.min(Math.max(0, current), safeTotal);
  progressWrap.hidden = false;
  progressBar.max = safeTotal;
  progressBar.value = safeCurrent;
  progressLabel.textContent = `${text} · ${safeCurrent} / ${safeTotal}`;
}

function hideProgress(): void {
  progressWrap.hidden = true;
  progressBar.value = 0;
  progressLabel.textContent = "";
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadPdf(bytes: Uint8Array, filename: string): void {
  downloadBlob(new Blob([bytes.slice().buffer], { type: "application/pdf" }), filename);
}

function safeDownloadStem(value: string): string {
  return (
    value
      .normalize("NFKC")
      .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[\s.-]+|[\s.-]+$/g, "")
      .slice(0, 120) || "batch"
  );
}

function startZipDownload(filename: string): void {
  const chunks: ArrayBuffer[] = [];
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      zipSession = null;
      busy = false;
      hideProgress();
      setMessage(error.message, "error");
      updateButton();
      return;
    }

    if (chunk) {
      chunks.push(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    }
    if (final) {
      const session = zipSession;
      zipSession = null;
      busy = false;
      downloadBlob(new Blob(chunks, { type: "application/zip" }), filename);
      hideProgress();
      setMessage(session?.successMessage || "ZIP archive is ready.", "success");
      updateButton();
    }
  });

  zipSession = {
    zip,
    chunks,
    filename,
    successMessage: "ZIP archive is ready.",
  };
}

function addFileToZip(filename: string, bytes: Uint8Array): void {
  if (!zipSession) return;
  const file = new ZipPassThrough(filename);
  zipSession.zip.add(file);
  file.push(bytes, true);
}

function finishZipDownload(message: string): void {
  if (!zipSession) return;
  zipSession.successMessage = message;
  zipSession.zip.end();
}

function parseCsv(source: string): string[][] {
  const firstRecord = source.split(/\r?\n/, 1)[0] ?? "";
  const delimiter =
    (firstRecord.match(/;/g)?.length ?? 0) >
    (firstRecord.match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  const matrix: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(value);
      matrix.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (quoted) throw new Error("CSV contains an unclosed quoted value.");
  if (value !== "" || row.length > 0) {
    row.push(value);
    matrix.push(row);
  }
  return matrix;
}

function parseMatrix(matrix: unknown[][]): {
  headers: string[];
  rows: SpreadsheetRow[];
  unusableColumns: string[];
} {
  const populatedRows = matrix.filter((cells) =>
    cells.some((cell) => String(cell ?? "").trim() !== ""),
  );
  if (populatedRows.length < 2) {
    throw new Error("The spreadsheet must contain a header and at least one data row.");
  }

  const rawHeaders = populatedRows[0].map((value, index) => {
    const header = String(value ?? "").replace(/^\ufeff/, "").trim();
    return { header, index };
  });
  const canonicalHeaderCounts = new Map<string, number>();
  rawHeaders.forEach(({ header }) => {
    if (!header) return;
    const canonical = canonicalHeader(header);
    canonicalHeaderCounts.set(canonical, (canonicalHeaderCounts.get(canonical) ?? 0) + 1);
  });

  const unusableColumns: string[] = [];
  const usableColumns = rawHeaders.flatMap(({ header, index }) => {
    if (!header) {
      unusableColumns.push(`Column ${index + 1}: empty header`);
      return [];
    }
    const duplicate = (canonicalHeaderCounts.get(canonicalHeader(header)) ?? 0) > 1;
    return [
      {
        header,
        index,
        key: duplicate ? `${columnLabel(index)} (${index + 1}) · ${header}` : header,
      },
    ];
  });

  if (usableColumns.length === 0) {
    throw new Error("The spreadsheet has no usable columns with non-empty headers.");
  }

  const parsedRows = populatedRows.slice(1).map((cells) =>
    Object.fromEntries(
      usableColumns.map(({ key, index }) => [
        key,
        String(cells[index] ?? "").trim(),
      ]),
    ),
  );
  return {
    headers: usableColumns.map(({ key }) => key),
    rows: parsedRows,
    unusableColumns,
  };
}

async function spreadsheetData(file: File): Promise<RawWorksheet[]> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "xlsx") {
    const sheets = await readXlsxFile(file);
    if (!sheets[0]) throw new Error("The workbook has no worksheets.");
    return sheets.map((sheet, index) => ({
      name: sheet.sheet || `Worksheet ${index + 1}`,
      data: sheet.data,
    }));
  }
  if (extension === "csv") {
    return [{ name: "CSV", data: parseCsv(await file.text()) }];
  }
  throw new Error("Choose a .csv or .xlsx file.");
}

function renderPreview(): void {
  const shownHeaders = headers.slice(0, 5);
  const shownRows = eligibleRows(exportRows()).slice(0, 6);
  preview.replaceChildren();

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  shownHeaders.forEach((header) => {
    const th = document.createElement("th");
    th.textContent = header;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  shownRows.forEach((row) => {
    const tr = document.createElement("tr");
    shownHeaders.forEach((header) => {
      const td = document.createElement("td");
      td.textContent = row[header] ?? "";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  preview.appendChild(table);
  preview.hidden = false;
}

function renderMapping(options: RenderMappingOptions = {}): void {
  const previousListScrollTop = mappingList.scrollTop;
  const previousWindowScrollY = window.scrollY;
  mappingList.replaceChildren();
  mappingCard.hidden = templateFields.length === 0 || headers.length === 0;

  if (mappingCard.hidden) {
    updateMappingSummary();
    return;
  }

  for (const field of templateFields) {
    const row = document.createElement("div");
    row.className = "mapping-row";

    const label = document.createElement("code");
    label.className = "mapping-field";
    label.title = templateFieldLabel(field);
    const labelName = document.createElement("span");
    labelName.textContent = field.name;
    label.appendChild(labelName);
    if (field.duplicateCount && field.duplicateCount > 1) {
      const duplicateSuffix = document.createElement("span");
      duplicateSuffix.className = "mapping-duplicate";
      duplicateSuffix.textContent = ` (${field.duplicateIndex ?? 1})`;
      label.appendChild(duplicateSuffix);
    }

    const arrow = document.createElement("span");
    arrow.className = "mapping-arrow";
    arrow.textContent = "→";

    const controls = document.createElement("div");
    controls.className = "mapping-controls";

    const entry = mappingEntry(field.id);
    entry.columns.forEach((currentColumn, columnIndex) => {
      const columnRow = document.createElement("div");
      columnRow.className = "mapping-column-row";

      const select = document.createElement("select");
      select.dataset.field = field.id;

      const ignore = document.createElement("option");
      ignore.value = "";
      ignore.textContent = columnIndex === 0 ? "Ignore" : "No extra column";
      select.appendChild(ignore);

      headers.forEach((header) => {
        const option = document.createElement("option");
        option.value = header;
        option.textContent = header;
        select.appendChild(option);
      });

      select.value = currentColumn && headers.includes(currentColumn) ? currentColumn : "";
      select.addEventListener("change", () => {
        entry.columns[columnIndex] = select.value;
        renderMapping({ preserveScroll: true });
        updateMappingSummary();
      });

      if (columnIndex === entry.columns.length - 1) {
        const addButton = document.createElement("button");
        addButton.className = "add-column";
        addButton.type = "button";
        addButton.textContent = "+";
        addButton.title = "Add another spreadsheet column";
        addButton.addEventListener("click", () => {
          entry.columns.push("");
          renderMapping({ preserveScroll: true });
        });
        columnRow.append(select, addButton);
      } else {
        const spacer = document.createElement("span");
        columnRow.append(select, spacer);
      }

      controls.appendChild(columnRow);
    });

    if (entry.columns.filter(Boolean).length > 1) {
      const separatorRow = document.createElement("label");
      separatorRow.className = "separator-row";
      const separatorLabel = document.createElement("span");
      separatorLabel.textContent = "Separator";
      const separatorInput = document.createElement("input");
      separatorInput.type = "text";
      separatorInput.value = entry.separator;
      separatorInput.placeholder = " ";
      separatorInput.addEventListener("input", () => {
        entry.separator = separatorInput.value;
      });
      separatorRow.append(separatorLabel, separatorInput);
      controls.appendChild(separatorRow);
    }

    row.append(label, arrow, controls);
    mappingList.appendChild(row);
  }
  if (options.preserveScroll) {
    const restoreScroll = () => {
      mappingList.scrollTop = previousListScrollTop;
      window.scrollTo(window.scrollX, previousWindowScrollY);
    };
    restoreScroll();
    requestAnimationFrame(restoreScroll);
  }
  updateMappingSummary();
}

function renderSkipRowColumn(): void {
  skipRowColumnSelect.replaceChildren();
  const noCondition = document.createElement("option");
  noCondition.value = "";
  noCondition.textContent = "Do not skip rows";
  skipRowColumnSelect.appendChild(noCondition);
  headers.forEach((header) => {
    const option = document.createElement("option");
    option.value = header;
    option.textContent = header;
    skipRowColumnSelect.appendChild(option);
  });
  if (!headers.includes(skipRowIfEmptyColumn)) skipRowIfEmptyColumn = "";
  skipRowColumnSelect.value = skipRowIfEmptyColumn;
}

function renderSheetControls(): void {
  sheetControls.hidden = workbookSheets.length <= 1;
  sheetSelect.replaceChildren();
  workbookSheets.forEach((sheet, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = sheet.name;
    sheetSelect.appendChild(option);
  });
  sheetSelect.value = String(selectedSheetIndex);
}

function resetBatchSelection(): void {
  batchSize = rows.length > 200 ? "100" : "all";
  batchIndex = 0;
  batchSizeSelect.value = batchSize;
}

function renderBatchControls(): void {
  const disabled = exportMode === "individual-pdfs";
  batchControls.hidden = rows.length === 0;
  batchControls.classList.toggle("disabled", disabled);
  batchNumberSelect.replaceChildren();
  if (batchControls.hidden) return;

  const count = batchCount();
  for (let index = 0; index < count; index += 1) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `Batch ${index + 1} (${batchRowRangeLabel(index)})`;
    batchNumberSelect.appendChild(option);
  }

  if (batchIndex >= count) batchIndex = Math.max(0, count - 1);
  batchSizeSelect.value = batchSize;
  batchNumberSelect.value = String(batchIndex);
  batchSizeSelect.disabled = disabled;
  batchNumberSelect.disabled = disabled || batchSize === "all" || count <= 1;
}

function renderExportControls(): void {
  const supportsIndividual = templateValid && templateCardCount === 1;
  exportControls.hidden = rows.length === 0 || !templateValid;
  exportModeSelect.disabled = !supportsIndividual;
  if (!supportsIndividual) exportMode = "combined-pdf";

  filenameColumnSelect.replaceChildren();
  headers.forEach((header) => {
    const option = document.createElement("option");
    option.value = header;
    option.textContent = header;
    filenameColumnSelect.appendChild(option);
  });

  if (!headers.includes(filenameColumn)) filenameColumn = headers[0] ?? "";
  const individualExport = exportMode === "individual-pdfs";
  exportModeSelect.value = exportMode;
  individualFormatSelect.value = individualFormat;
  pngScaleSelect.value = String(pngScale);
  individualFormatRow.hidden = !individualExport;
  pngScaleSelect.hidden = !individualExport || !individualFormatUsesScale();
  filenameColumnSelect.value = filenameColumn;
  filenameColumnSelect.hidden = !individualExport;
  filenameAffixes.hidden = !individualExport;
  filenamePrefixInput.value = filenamePrefix;
  filenameSuffixInput.value = filenameSuffix;
  deleteGeneratedPageInput.checked = deleteGeneratedPage;
}

function applySelectedSheet(index: number): void {
  const sheet = workbookSheets[index];
  if (!sheet) return;

  selectedSheetIndex = index;
  rows = [];
  headers = [];
  unusableColumnMessages = [];
  mapping = {};
  skipRowIfEmptyColumn = "";
  individualFormat = "pdf";
  pngScale = 1;
  filenameColumn = "";
  filenamePrefix = "";
  filenameSuffix = "";
  preview.hidden = true;

  try {
    const parsed = parseMatrix(sheet.data);
    headers = parsed.headers;
    rows = parsed.rows;
    unusableColumnMessages = parsed.unusableColumns;
    resetBatchSelection();
    renderSheetControls();
    renderSkipRowColumn();
    renderBatchControls();
    renderExportControls();
    applyAutomaticMapping();
    updateSummary();
    renderPreview();
    setMessage(
      unusableColumnMessages.length > 0
        ? `Spreadsheet is valid. ${unusableColumnMessages.slice(0, 3).join("; ")}${
            unusableColumnMessages.length > 3 ? "; ..." : ""
          }`
        : "Spreadsheet is valid. Review the field mapping.",
      "success",
    );
  } catch (error) {
    renderSheetControls();
    renderBatchControls();
    renderExportControls();
    renderMapping();
    summary.textContent = "No valid worksheet selected.";
    setMessage(
      `Selected worksheet is invalid: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
  updateButton();
}

function applyAutomaticMapping(): void {
  mapping = Object.fromEntries(
    templateFields.map((field) => [
      field.id,
      { columns: [autoColumnForField(field.name)], separator: " " },
    ]),
  );
  renderMapping();
}

async function loadFile(file: File): Promise<void> {
  rows = [];
  headers = [];
  unusableColumnMessages = [];
  workbookSheets = [];
  selectedSheetIndex = 0;
  loadedFileName = "";
  skipRowIfEmptyColumn = "";
  batchIndex = 0;
  exportMode = "combined-pdf";
  individualFormat = "pdf";
  pngScale = 1;
  filenameColumn = "";
  filenamePrefix = "";
  filenameSuffix = "";
  sheetControls.hidden = true;
  batchControls.hidden = true;
  exportControls.hidden = true;
  preview.hidden = true;
  setMessage("Reading spreadsheet…");
  updateButton();

  try {
    workbookSheets = await spreadsheetData(file);
    loadedFileName = file.name;
    applySelectedSheet(0);
  } catch (error) {
    mapping = {};
    mappingCard.hidden = true;
    sheetControls.hidden = true;
    batchControls.hidden = true;
    exportControls.hidden = true;
    summary.textContent = "No valid spreadsheet loaded.";
    setMessage(error instanceof Error ? error.message : String(error), "error");
  }
  updateButton();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});

for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("drag");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("drag");
  });
}

dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files[0];
  if (file) void loadFile(file);
});

autoMatchButton.addEventListener("click", applyAutomaticMapping);
sheetSelect.addEventListener("change", () => {
  applySelectedSheet(Number(sheetSelect.value));
});
batchSizeSelect.addEventListener("change", () => {
  batchSize = batchSizeSelect.value;
  batchIndex = 0;
  renderBatchControls();
  updateSummary();
  renderPreview();
  updateButton();
});
batchNumberSelect.addEventListener("change", () => {
  batchIndex = Number(batchNumberSelect.value);
  updateSummary();
  renderPreview();
  updateButton();
});
exportModeSelect.addEventListener("change", () => {
  exportMode = exportModeSelect.value as ExportMode;
  renderExportControls();
  renderBatchControls();
  updateSummary();
  renderPreview();
  updateButton();
});
individualFormatSelect.addEventListener("change", () => {
  individualFormat = individualFormatSelect.value as IndividualExportFormat;
  renderExportControls();
  updateButton();
});
pngScaleSelect.addEventListener("change", () => {
  pngScale = Number(pngScaleSelect.value) || 1;
});
filenameColumnSelect.addEventListener("change", () => {
  filenameColumn = filenameColumnSelect.value;
  updateButton();
});
filenamePrefixInput.addEventListener("input", () => {
  filenamePrefix = filenamePrefixInput.value;
});
filenameSuffixInput.addEventListener("input", () => {
  filenameSuffix = filenameSuffixInput.value;
});
deleteGeneratedPageInput.addEventListener("change", () => {
  deleteGeneratedPage = deleteGeneratedPageInput.checked;
});
skipRowColumnSelect.addEventListener("change", () => {
  skipRowIfEmptyColumn = skipRowColumnSelect.value;
  updateSummary();
  renderPreview();
  updateButton();
});

generateButton.addEventListener("click", () => {
  busy = true;
  updateButton();
  hideProgress();
  if (exportMode === "individual-pdfs") {
    startZipDownload(`${safeDownloadStem(batchLabel())}-${individualFormat}s.zip`);
  }
  setMessage("Generating frames…");
  const pluginMessage: UiToPluginMessage = {
    type: "generate",
    rows: exportRows(),
    mapping: sanitizedMapping(),
    skipRowIfEmptyColumn: skipRowIfEmptyColumn || undefined,
    batchLabel: batchLabel(),
    exportMode,
    filenameColumn: exportMode === "individual-pdfs" ? filenameColumn : undefined,
    filenamePrefix: exportMode === "individual-pdfs" ? filenamePrefix : undefined,
    filenameSuffix: exportMode === "individual-pdfs" ? filenameSuffix : undefined,
    individualFormat: exportMode === "individual-pdfs" ? individualFormat : undefined,
    pngScale:
      exportMode === "individual-pdfs" && individualFormatUsesScale()
        ? pngScale
        : undefined,
    deleteGeneratedPage,
  };
  parent.postMessage({ pluginMessage }, "*");
});

window.onmessage = (event: MessageEvent<{ pluginMessage?: PluginToUiMessage }>) => {
  const pluginMessage = event.data.pluginMessage;
  if (!pluginMessage) return;

  if (pluginMessage.type === "selection") {
    templateValid = pluginMessage.valid;
    templateCardCount = pluginMessage.valid ? pluginMessage.cardCount ?? null : null;
    templateFields = pluginMessage.valid ? pluginMessage.fields ?? [] : [];
    layoutMode = pluginMessage.valid ? pluginMessage.layoutMode ?? null : null;
    templateStatus.className = `card status ${pluginMessage.valid ? "valid" : "invalid"}`;
    templateMessage.textContent = pluginMessage.message;
    mapping = {};
    if (headers.length > 0 && templateFields.length > 0) applyAutomaticMapping();
    else renderMapping();
    renderExportControls();
    renderBatchControls();
    updateSummary();
  } else if (pluginMessage.type === "working") {
    busy = true;
    setMessage(pluginMessage.message);
  } else if (pluginMessage.type === "progress") {
    busy = true;
    setMessage(pluginMessage.message);
    setProgress(pluginMessage.message, pluginMessage.current, pluginMessage.total);
  } else if (pluginMessage.type === "success") {
    if (zipSession) {
      finishZipDownload(pluginMessage.message);
    } else {
      busy = false;
      hideProgress();
      if (pluginMessage.pdf && pluginMessage.filename) {
        downloadPdf(pluginMessage.pdf, pluginMessage.filename);
      }
      setMessage(pluginMessage.message, "success");
    }
  } else if (pluginMessage.type === "individual-file") {
    addFileToZip(pluginMessage.filename, pluginMessage.bytes);
  } else if (pluginMessage.type === "error") {
    if (zipSession) {
      zipSession.zip.terminate();
      zipSession = null;
    }
    busy = false;
    hideProgress();
    setMessage(pluginMessage.message, "error");
  }
  updateButton();
};

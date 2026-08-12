import { PDFDocument } from "pdf-lib";
import {
  type ExportMode,
  type FieldMapping,
  type LayoutMode,
  type PluginToUiMessage,
  type SpreadsheetRow,
  type UiToPluginMessage,
} from "./shared";

type TemplateNode = FrameNode | ComponentNode;
type CardContainer = FrameNode | GroupNode | ComponentNode | InstanceNode;
type CardDescriptor = {
  index: number;
  container: CardContainer | null;
};
type TemplateSpec = {
  mode: LayoutMode;
  cards: CardDescriptor[];
  fields: string[];
  errors: string[];
};

const CARD_NAME_PATTERN = /^(?:(?:card|slot|item)[\s_-]*)?(\d+)[\s_-]*$/i;
const LEGACY_FIELD_PATTERN = /^(\d+)_(.+)$/;
const RESERVED_FILENAME_STEMS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

figma.showUI(__html__, { width: 560, height: 760, themeColors: true });

const fontCache = new Set<string>();

function post(message: PluginToUiMessage): void {
  figma.ui.postMessage(message);
}

function postProgress(message: string, current: number, total: number): void {
  post({ type: "progress", message, current, total });
}

function selectedTemplate(): TemplateNode | null {
  const selection = figma.currentPage.selection;
  if (selection.length !== 1) return null;
  const node = selection[0];
  return node.type === "FRAME" || node.type === "COMPONENT" ? node : null;
}

function isCardContainer(node: SceneNode): node is CardContainer {
  return (
    node.type === "FRAME" ||
    node.type === "GROUP" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE"
  );
}

function textNodes(root: TemplateNode | CardContainer): TextNode[] {
  return root.findAllWithCriteria({ types: ["TEXT"] });
}

function fieldName(node: TextNode): string {
  return node.name.trim() || node.characters.trim();
}

function inspectContainerTemplate(root: TemplateNode): TemplateSpec | null {
  const indexedContainers = root
    .findAll((node) => isCardContainer(node) && CARD_NAME_PATTERN.test(node.name.trim()))
    .filter(isCardContainer)
    .map((container) => ({
      index: Number(container.name.trim().match(CARD_NAME_PATTERN)?.[1]),
      container,
    }))
    .sort((left, right) => left.index - right.index);

  if (indexedContainers.length === 0) return null;

  const errors: string[] = [];
  const seenIndices = new Set<number>();
  const fields = new Set<string>();

  for (const card of indexedContainers) {
    if (seenIndices.has(card.index)) {
      errors.push(`Duplicate item slot container index: ${card.index}`);
    }
    seenIndices.add(card.index);

    const namesInCard = new Set<string>();
    for (const node of textNodes(card.container)) {
      const name = fieldName(node);
      if (!name) continue;
      if (namesInCard.has(name)) {
        errors.push(`Item slot ${card.index} contains duplicate text layer "${name}"`);
      }
      namesInCard.add(name);
      fields.add(name);
    }
  }

  if (fields.size === 0) errors.push("Item slot containers contain no text layers.");

  return {
    mode: "containers",
    cards: indexedContainers,
    fields: [...fields].sort((left, right) => left.localeCompare(right, "en")),
    errors,
  };
}

function inspectLegacyTemplate(root: TemplateNode): TemplateSpec {
  const indices = new Set<number>();
  const fields = new Set<string>();

  for (const node of textNodes(root)) {
    for (const value of [node.name.trim(), node.characters.trim()]) {
      const match = value.match(LEGACY_FIELD_PATTERN);
      if (!match) continue;
      indices.add(Number(match[1]));
      fields.add(match[2]);
    }
  }

  const cards = [...indices]
    .sort((left, right) => left - right)
    .map((index) => ({ index, container: null }));
  const errors: string[] = [];
  if (cards.length === 0) {
    errors.push("No indexed item slot containers or legacy N_field keys were found.");
  }

  return {
    mode: "legacy",
    cards,
    fields: [...fields].sort((left, right) => left.localeCompare(right, "en")),
    errors,
  };
}

function inspectSingleFrameTemplate(root: TemplateNode): TemplateSpec {
  const fields = new Set<string>();
  const namesInFrame = new Set<string>();
  const errors: string[] = [];

  for (const node of textNodes(root)) {
    const name = fieldName(node);
    if (!name) continue;
    if (namesInFrame.has(name)) {
      errors.push(`Template frame contains duplicate text layer "${name}"`);
    }
    namesInFrame.add(name);
    fields.add(name);
  }

  if (fields.size === 0) {
    errors.push("Template frame contains no text layers.");
  }

  return {
    mode: "single-frame",
    cards: [{ index: 0, container: root }],
    fields: [...fields].sort((left, right) => left.localeCompare(right, "en")),
    errors,
  };
}

function inspectTemplate(root: TemplateNode): TemplateSpec {
  const containerSpec = inspectContainerTemplate(root);
  if (containerSpec) return containerSpec;

  const legacySpec = inspectLegacyTemplate(root);
  if (legacySpec.errors.length === 0) return legacySpec;

  return inspectSingleFrameTemplate(root);
}

function publishSelectionState(): void {
  const template = selectedTemplate();
  if (!template) {
    post({
      type: "selection",
      valid: false,
      message: "Select exactly one template frame or component.",
    });
    return;
  }

  const spec = inspectTemplate(template);
  if (spec.errors.length > 0) {
    post({
      type: "selection",
      valid: false,
      message: spec.errors.slice(0, 3).join(" · "),
    });
    return;
  }

  const modeLabel =
    spec.mode === "containers"
      ? "indexed containers"
      : spec.mode === "single-frame"
        ? "selected frame as one slot"
        : "legacy N_field keys";
  post({
    type: "selection",
    valid: true,
    message: `${template.name} · ${spec.cards.length} item slot(s) · ${modeLabel}`,
    cardCount: spec.cards.length,
    fields: spec.fields,
    layoutMode: spec.mode,
  });
}

async function loadNodeFonts(node: TextNode): Promise<void> {
  const fonts =
    node.characters.length > 0
      ? node.getRangeAllFontNames(0, node.characters.length)
      : node.fontName === figma.mixed
        ? []
        : [node.fontName];

  for (const font of fonts) {
    const cacheKey = `${font.family}\u0000${font.style}`;
    if (fontCache.has(cacheKey)) continue;
    await figma.loadFontAsync(font);
    fontCache.add(cacheKey);
  }
}

async function replaceText(node: TextNode, value: string, label: string): Promise<void> {
  if (node.hasMissingFont) {
    throw new Error(`Layer ${label} uses a missing font.`);
  }
  await loadNodeFonts(node);
  node.autoRename = false;
  node.characters = value;
}

function findContainerField(card: CardDescriptor, field: string): TextNode | null {
  if (!card.container) return null;
  return textNodes(card.container).find((node) => fieldName(node) === field) ?? null;
}

function findLegacyField(root: TemplateNode, cardIndex: number, field: string): TextNode | null {
  const fullKey = `${cardIndex}_${field}`;
  return (
    textNodes(root).find((node) => node.name.trim() === fullKey) ??
    textNodes(root).find((node) => node.characters.trim() === fullKey) ??
    null
  );
}

async function fillCard(
  root: TemplateNode,
  spec: TemplateSpec,
  card: CardDescriptor,
  row: SpreadsheetRow | null,
  mapping: FieldMapping,
): Promise<void> {
  for (const [field, mappingEntry] of Object.entries(mapping)) {
    const columns = mappingEntry.columns.filter(Boolean);
    if (columns.length === 0) continue;
    const node =
      spec.mode === "containers" || spec.mode === "single-frame"
        ? findContainerField(card, field)
        : findLegacyField(root, card.index, field);
    if (!node) continue;

    const values =
      row === null
        ? []
        : columns
            .map((column) => row[column] ?? "")
            .map((value) => value.trim())
            .filter(Boolean);
    const rawValue = values.join(mappingEntry.separator ?? " ");
    await replaceText(node, rawValue || "—", `${card.index}:${field}`);
  }
}

function validateInput(
  rows: SpreadsheetRow[],
  mapping: FieldMapping,
  skipRowIfEmptyColumn?: string,
  filenameColumn?: string,
): void {
  if (rows.length === 0) throw new Error("The spreadsheet contains no data rows.");
  const mappedColumns = Object.values(mapping).flatMap((entry) =>
    entry.columns.filter(Boolean),
  );
  if (mappedColumns.length === 0) throw new Error("Map at least one text layer to a spreadsheet column.");

  const availableColumns = new Set(Object.keys(rows[0]));
  for (const [field, mappingEntry] of Object.entries(mapping)) {
    for (const column of mappingEntry.columns.filter(Boolean)) {
      if (!availableColumns.has(column)) {
        throw new Error(`Field "${field}" refers to missing column "${column}".`);
      }
    }
  }
  if (skipRowIfEmptyColumn && !availableColumns.has(skipRowIfEmptyColumn)) {
    throw new Error(
      `Skip condition refers to missing column "${skipRowIfEmptyColumn}".`,
    );
  }
  if (filenameColumn && !availableColumns.has(filenameColumn)) {
    throw new Error(`Filename column "${filenameColumn}" is missing from the spreadsheet.`);
  }

  rows.forEach((row, index) => {
    for (const [column, value] of Object.entries(row)) {
      if (typeof value !== "string") {
        throw new Error(`Row ${index + 2}: invalid value in column ${column}.`);
      }
    }
  });
}

function safeFilenameStem(value: string, fallback: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .replace(/\.pdf$/i, "")
    .trim()
    .slice(0, 120)
    .replace(/^[\s.-]+|[\s.-]+$/g, "");

  if (!sanitized || RESERVED_FILENAME_STEMS.test(sanitized)) return fallback;
  return sanitized;
}

function uniquePdfFilenames(
  rows: SpreadsheetRow[],
  filenameColumn: string,
  filenamePrefix = "",
  filenameSuffix = "",
): string[] {
  const counts = new Map<string, number>();
  return rows.map((row, index) => {
    const rowFallback = `row-${String(index + 1).padStart(3, "0")}`;
    const fallback = safeFilenameStem(
      `${filenamePrefix}${rowFallback}${filenameSuffix}`,
      rowFallback,
    );
    const rawValue = (row[filenameColumn] ?? "").trim();
    const rawStem = rawValue
      ? `${filenamePrefix}${rawValue}${filenameSuffix}`
      : `${filenamePrefix}${rowFallback}${filenameSuffix}`;
    const stem = safeFilenameStem(rawStem, fallback);
    const nextCount = (counts.get(stem.toLocaleLowerCase()) ?? 0) + 1;
    counts.set(stem.toLocaleLowerCase(), nextCount);
    return `${nextCount === 1 ? stem : `${stem}-${nextCount}`}.pdf`;
  });
}

async function generate(
  rows: SpreadsheetRow[],
  mapping: FieldMapping,
  skipRowIfEmptyColumn?: string,
  batchLabel?: string,
  exportMode: ExportMode = "combined-pdf",
  filenameColumn?: string,
  filenamePrefix?: string,
  filenameSuffix?: string,
): Promise<void> {
  validateInput(rows, mapping, skipRowIfEmptyColumn, filenameColumn);
  const eligibleRows = skipRowIfEmptyColumn
    ? rows.filter((row) => Boolean((row[skipRowIfEmptyColumn] ?? "").trim()))
    : rows;
  const skippedRowCount = rows.length - eligibleRows.length;
  if (eligibleRows.length === 0) {
    throw new Error(
      skipRowIfEmptyColumn
        ? `Every row is empty in "${skipRowIfEmptyColumn}". Nothing to generate.`
        : "The spreadsheet contains no data rows.",
    );
  }
  const template = selectedTemplate();
  if (!template) throw new Error("Select exactly one template frame or component.");

  const sourceSpec = inspectTemplate(template);
  if (sourceSpec.errors.length > 0) throw new Error(sourceSpec.errors.join(" · "));

  const unknownFields = Object.keys(mapping).filter((field) => !sourceSpec.fields.includes(field));
  if (unknownFields.length > 0) {
    throw new Error(`Mapped fields are no longer present in the template: ${unknownFields.join(", ")}`);
  }

  const cardCount = sourceSpec.cards.length;
  if (exportMode === "individual-pdfs" && cardCount !== 1) {
    throw new Error("Individual PDF export is available only when the template has exactly one item slot.");
  }
  if (exportMode === "individual-pdfs" && !filenameColumn) {
    throw new Error("Choose a spreadsheet column for individual PDF filenames.");
  }

  const pageCount = Math.ceil(eligibleRows.length / cardCount);
  postProgress("Generating frames", 0, pageCount);

  const clones: TemplateNode[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const clone = template.clone();
    clone.name = `Generated page ${index + 1}`;
    clones.push(clone);
  }

  for (let pageIndex = 0; pageIndex < clones.length; pageIndex += 1) {
    const cloneSpec = inspectTemplate(clones[pageIndex]);
    if (cloneSpec.errors.length > 0) throw new Error(cloneSpec.errors.join(" · "));

    for (let slot = 0; slot < cloneSpec.cards.length; slot += 1) {
      const row = eligibleRows[pageIndex * cardCount + slot] ?? null;
      await fillCard(clones[pageIndex], cloneSpec, cloneSpec.cards[slot], row, mapping);
    }
    postProgress("Generating frames", pageIndex + 1, pageCount);
  }

  const outputPage = figma.createPage();
  outputPage.name = `Generated batch ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;

  let y = 0;
  for (const clone of clones) {
    outputPage.appendChild(clone);
    clone.x = 0;
    clone.y = y;
    y += clone.height + 80;
  }

  await figma.setCurrentPageAsync(outputPage);
  figma.currentPage.selection = clones;
  figma.viewport.scrollAndZoomIntoView(clones);

  if (exportMode === "individual-pdfs") {
    postProgress("Rendering PDFs into ZIP", 0, clones.length);
    const filenames = uniquePdfFilenames(
      eligibleRows,
      filenameColumn ?? "",
      filenamePrefix,
      filenameSuffix,
    );
    for (let index = 0; index < clones.length; index += 1) {
      post({
        type: "individual-file",
        filename: filenames[index],
        pdf: await clones[index].exportAsync({ format: "PDF" }),
      });
      postProgress("Rendering PDFs into ZIP", index + 1, clones.length);
    }
    post({
      type: "success",
      message: `${clones.length} individual PDF file(s) generated.${skippedRowCount ? ` ${skippedRowCount} row(s) skipped because "${skipRowIfEmptyColumn}" was empty.` : ""}`,
    });
    figma.notify(`Generated ${clones.length} PDF file(s)`);
    return;
  }

  postProgress("Rendering and combining PDF pages", 0, clones.length);
  const mergedPdf = await PDFDocument.create();
  for (let index = 0; index < clones.length; index += 1) {
    const clone = clones[index];
    const pagePdf = await PDFDocument.load(await clone.exportAsync({ format: "PDF" }));
    const copiedPages = await mergedPdf.copyPages(pagePdf, pagePdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
    postProgress("Rendering and combining PDF pages", index + 1, clones.length);
  }
  const pdf = await mergedPdf.save();

  const safeBatchLabel = (batchLabel ?? "batch")
    .normalize("NFKC")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  post({
    type: "success",
    message: `${eligibleRows.length} row(s) generated on ${pageCount} page(s), ${cardCount} item slot(s) per page.${skippedRowCount ? ` ${skippedRowCount} row(s) skipped because "${skipRowIfEmptyColumn}" was empty.` : ""}`,
    pdf,
    filename: `${safeBatchLabel || "batch"}-render.pdf`,
  });
  figma.notify(`Generated ${pageCount} page(s)`);
}

figma.ui.onmessage = async (message: UiToPluginMessage) => {
  if (message.type !== "generate") return;
  try {
    await generate(
      message.rows,
      message.mapping,
      message.skipRowIfEmptyColumn,
      message.batchLabel,
      message.exportMode,
      message.filenameColumn,
      message.filenamePrefix,
      message.filenameSuffix,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "error", message });
    figma.notify(message, { error: true });
  }
};

figma.on("selectionchange", publishSelectionState);
publishSelectionState();

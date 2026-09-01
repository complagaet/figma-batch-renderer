export type SpreadsheetRow = Record<string, string>;
export type FieldMappingEntry = {
  columns: string[];
  separator: string;
};
export type FieldMapping = Record<string, FieldMappingEntry>;
export type LayoutMode = "containers" | "single-frame" | "legacy";
export type ExportMode = "combined-pdf" | "individual-pdfs";
export type IndividualExportFormat = "pdf" | "png" | "jpg";
export type TemplateField = {
  id: string;
  name: string;
  duplicateIndex?: number;
  duplicateCount?: number;
};

export type UiToPluginMessage = {
  type: "generate";
  rows: SpreadsheetRow[];
  mapping: FieldMapping;
  skipRowIfEmptyColumn?: string;
  batchLabel?: string;
  exportMode?: ExportMode;
  filenameColumn?: string;
  filenamePrefix?: string;
  filenameSuffix?: string;
  individualFormat?: IndividualExportFormat;
  pngScale?: number;
  deleteGeneratedPage?: boolean;
};

export type PluginToUiMessage =
  | {
      type: "selection";
      valid: boolean;
      message: string;
      cardCount?: number;
      fields?: TemplateField[];
      layoutMode?: LayoutMode;
    }
  | { type: "working"; message: string }
  | { type: "progress"; message: string; current: number; total: number }
  | {
      type: "success";
      message: string;
      pdf?: Uint8Array;
      filename?: string;
    }
  | { type: "individual-file"; bytes: Uint8Array; filename: string }
  | { type: "error"; message: string };

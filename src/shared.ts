export type SpreadsheetRow = Record<string, string>;
export type FieldMappingEntry = {
  columns: string[];
  separator: string;
};
export type FieldMapping = Record<string, FieldMappingEntry>;
export type LayoutMode = "containers" | "single-frame" | "legacy";
export type ExportMode = "combined-pdf" | "individual-pdfs";

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
};

export type PluginToUiMessage =
  | {
      type: "selection";
      valid: boolean;
      message: string;
      cardCount?: number;
      fields?: string[];
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
  | { type: "individual-file"; pdf: Uint8Array; filename: string }
  | { type: "error"; message: string };

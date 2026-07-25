export const COPYQ_OUTPUT_BUDGET_BYTES = 7 * 1024 * 1024;
export const COPYQ_PAGE_ITEMS = 250;

export interface CopyqCursor {
  tab: number;
  row: number;
}

export interface CopyqRecord {
  type: "text" | "image";
  content: string;
  tab?: string;
}

export interface CopyqPage {
  records: CopyqRecord[];
  sourceTabs: string[];
  skipped: number;
  scanned: number;
  total: number;
  done: boolean;
  nextCursor?: CopyqCursor;
}

interface CopyqMetadata {
  __cliporax_copyq: 2;
  tabs: string[];
  skipped: number;
  scanned: number;
  total: number;
  done: boolean;
  nextTab: number;
  nextRow: number;
}

export function createCopyqPageScript(
  maxItems: number,
  maxTextBytes: number,
  maxImageContentBytes: number,
): string {
  return [
    `var maxItems=${maxItems},maxTextBytes=${maxTextBytes},maxImageContentBytes=${maxImageContentBytes},maxOutputBytes=${COPYQ_OUTPUT_BUDGET_BYTES};`,
    "var tabs=tab(),used=0,emitted=0,skipped=0,scanned=0,total=0;",
    "for(var c=0;c<tabs.length;c++){tab(tabs[c]);total+=size();}",
    "var startTab=parseInt(str(arguments[1])),startRow=parseInt(str(arguments[2]));",
    "var t=isNaN(startTab)?tabs.length-1:startTab;",
    "if(t>=tabs.length)t=tabs.length-1;",
    "var i=startRow;",
    "if(isNaN(i)&&t>=0){tab(tabs[t]);i=size()-1;}",
    "var imageMimes=['image/png','image/jpeg','image/webp','image/bmp','image/svg+xml'];",
    "outer:while(t>=0){",
    "tab(tabs[t]);if(i>=size())i=size()-1;",
    "while(i>=0){",
    "if(scanned>=maxItems)break outer;",
    "var image=new ByteArray(),imageMime='';",
    "for(var m=0;m<imageMimes.length;m++){image=read(imageMimes[m],i);if(image.size()>0){imageMime=imageMimes[m];break;}}",
    "var type='text',content='';",
    "if(image.size()>0){type='image';content='data:'+imageMime+';base64,'+str(image.toBase64());}",
    "else{content=str(read(i));}",
    "scanned++;",
    "var contentBytes=new ByteArray(content).size();",
    "var invalid=!content||(type==='text'&&!content.trim())||(type==='text'&&contentBytes>maxTextBytes)||(type==='image'&&contentBytes>maxImageContentBytes);",
    "if(invalid){skipped++;i--;continue;}",
    "var line=JSON.stringify({tab:tabs[t],type:type,content:content})+'\\n';",
    "var lineBytes=new ByteArray(line).size();",
    "if(lineBytes>maxOutputBytes){skipped++;i--;continue;}",
    "if(used+lineBytes>maxOutputBytes){scanned--;break outer;}",
    "print(line);used+=lineBytes;emitted++;i--;",
    "}",
    "if(i<0){t--;if(t>=0){tab(tabs[t]);i=size()-1;}}",
    "}",
    "var done=t<0;",
    "print(JSON.stringify({__cliporax_copyq:2,tabs:tabs,skipped:skipped,scanned:scanned,total:total,done:done,nextTab:t,nextRow:i})+'\\n');",
  ].join("");
}

export function createCopyqPageArguments(
  cursor: CopyqCursor | undefined,
  maxItems: number,
  maxTextBytes: number,
  maxImageContentBytes: number,
): string[] {
  // CopyQ otherwise expands sequences such as "\n" in command-line arguments
  // before eval sees the script, turning the quoted newline into invalid syntax.
  return [
    "eval",
    "--",
    createCopyqPageScript(maxItems, maxTextBytes, maxImageContentBytes),
    cursor ? String(cursor.tab) : "",
    cursor ? String(cursor.row) : "",
  ];
}

function isCopyqMetadata(value: unknown): value is CopyqMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CopyqMetadata>;
  return candidate.__cliporax_copyq === 2
    && Array.isArray(candidate.tabs)
    && candidate.tabs.every((tab) => typeof tab === "string")
    && Number.isInteger(candidate.skipped)
    && (candidate.skipped ?? -1) >= 0
    && Number.isInteger(candidate.scanned)
    && (candidate.scanned ?? -1) >= 0
    && Number.isInteger(candidate.total)
    && (candidate.total ?? -1) >= 0
    && typeof candidate.done === "boolean"
    && Number.isInteger(candidate.nextTab)
    && Number.isInteger(candidate.nextRow);
}

export function parseCopyqPage(stdout: string): CopyqPage {
  const records: CopyqRecord[] = [];
  let invalidLines = 0;
  let metadata: CopyqMetadata | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isCopyqMetadata(value)) {
        metadata = value;
        continue;
      }
      const record = value as { type?: unknown; content?: unknown; tab?: unknown };
      if (
        (record.type !== "text" && record.type !== "image")
        || typeof record.content !== "string"
        || !record.content
      ) {
        invalidLines += 1;
        continue;
      }
      records.push({
        type: record.type,
        content: record.content,
        tab: typeof record.tab === "string" ? record.tab : undefined,
      });
    } catch {
      invalidLines += 1;
    }
  }

  if (!metadata) {
    throw new Error("CopyQ did not return pagination metadata.");
  }
  return {
    records,
    sourceTabs: metadata.tabs,
    skipped: metadata.skipped + invalidLines,
    scanned: metadata.scanned,
    total: metadata.total,
    done: metadata.done,
    nextCursor: metadata.done
      ? undefined
      : { tab: metadata.nextTab, row: metadata.nextRow },
  };
}

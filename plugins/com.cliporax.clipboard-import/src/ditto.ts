export const DITTO_PAGE_ITEMS = 1_000;
export const DITTO_OUTPUT_BUDGET_BYTES = 6_500_000;

export interface DittoPage {
  records: Array<{ type: "text"; content: string }>;
  scanned: number;
  skipped: number;
  total: number;
  done: boolean;
  nextOffset?: number;
}

interface DittoMetadata {
  __cliporax_ditto: number;
  scanned: number;
  skipped: number;
  total: number;
  done: boolean;
  nextOffset: number | null;
}

const POWERSHELL_DECODER =
  ";$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))|ConvertFrom-Json;" +
  "&([ScriptBlock]::Create($p.script)) $p.sourcePath $p.offset $p.pageItems $p.outputBudget";

export const DITTO_POWERSHELL_SCRIPT = String.raw`
param(
  [AllowNull()][string]$SourcePath,
  [int]$Offset,
  [int]$PageItems,
  [int]$OutputBudget
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Find-DittoDatabase {
  $candidates = [Collections.Generic.List[string]]::new()
  if ($env:APPDATA) {
    $candidates.Add((Join-Path $env:APPDATA "Ditto\Ditto.db"))
  }
  if ($env:LOCALAPPDATA) {
    $packages = Join-Path $env:LOCALAPPDATA "Packages"
    if (Test-Path -LiteralPath $packages) {
      Get-ChildItem -LiteralPath $packages -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*ditto*" } |
        Sort-Object FullName |
        ForEach-Object {
          $candidates.Add((Join-Path $_.FullName "LocalCache\Local\Ditto_WindowsApp\Ditto.db"))
        }
    }
  }
  foreach ($programFiles in @(
    $env:ProgramFiles,
    [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  )) {
    if ($programFiles) {
      $candidates.Add((Join-Path $programFiles "Ditto\Ditto.db"))
    }
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw "Could not find Ditto.db automatically. Export a Ditto .zdb backup and enter its full path."
}

function Expand-DittoBackup([string]$Path) {
  $temporary = [IO.Path]::GetTempFileName()
  $input = $null
  $gzip = $null
  $output = $null
  try {
    $input = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $gzip = [IO.Compression.GZipStream]::new($input, [IO.Compression.CompressionMode]::Decompress)
    $output = [IO.File]::Open($temporary, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buffer = [byte[]]::new(65536)
    [long]$written = 0
    while (($read = $gzip.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $written += $read
      if ($written -gt 536870912) {
        throw "The Ditto .zdb backup expands beyond the 512 MiB safety limit."
      }
      $output.Write($buffer, 0, $read)
    }
    return $temporary
  } catch {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    throw
  } finally {
    if ($output) { $output.Dispose() }
    if ($gzip) { $gzip.Dispose() }
    if ($input) { $input.Dispose() }
  }
}

if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  $SourcePath = Find-DittoDatabase
} else {
  $SourcePath = (Resolve-Path -LiteralPath $SourcePath -ErrorAction Stop).Path
}
if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
  throw "The Ditto source file does not exist."
}
$extension = [IO.Path]::GetExtension($SourcePath)
if ($extension -notin @(".db", ".zdb")) {
  throw "Ditto source must be a Ditto.db or .zdb backup."
}

$temporaryDatabase = $null
$databasePath = $SourcePath
if ($extension -ieq ".zdb") {
  $temporaryDatabase = Expand-DittoBackup $SourcePath
  $databasePath = $temporaryDatabase
}

if (-not ("CliporaxWinSqlite" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CliporaxWinSqlite {
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int sqlite3_open_v2(IntPtr filename, out IntPtr db, int flags, IntPtr vfs);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int sqlite3_close(IntPtr db);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int sqlite3_busy_timeout(IntPtr db, int milliseconds);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern IntPtr sqlite3_errmsg(IntPtr db);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int sqlite3_prepare_v2(IntPtr db, IntPtr sql, int bytes, out IntPtr statement, IntPtr tail);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int sqlite3_step(IntPtr statement);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int sqlite3_finalize(IntPtr statement);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern IntPtr sqlite3_column_text16(IntPtr statement, int column);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern IntPtr sqlite3_column_blob(IntPtr statement, int column);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int sqlite3_column_bytes(IntPtr statement, int column);
  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern long sqlite3_column_int64(IntPtr statement, int column);
}
'@
}

function New-Utf8Pointer([string]$Value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value + [char]0)
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
  return $pointer
}

function Get-SqliteError([IntPtr]$Database) {
  $pointer = [CliporaxWinSqlite]::sqlite3_errmsg($Database)
  if ($pointer -eq [IntPtr]::Zero) { return "unknown SQLite error" }
  return [Runtime.InteropServices.Marshal]::PtrToStringAnsi($pointer)
}

function Open-Statement([IntPtr]$Database, [string]$Sql) {
  $sqlPointer = New-Utf8Pointer $Sql
  try {
    [IntPtr]$statement = [IntPtr]::Zero
    $result = [CliporaxWinSqlite]::sqlite3_prepare_v2(
      $Database,
      $sqlPointer,
      -1,
      [ref]$statement,
      [IntPtr]::Zero
    )
    if ($result -ne 0) {
      throw "Unsupported or unreadable Ditto database: $(Get-SqliteError $Database)"
    }
    return $statement
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($sqlPointer)
  }
}

function Get-ColumnText([IntPtr]$Statement, [int]$Column) {
  $pointer = [CliporaxWinSqlite]::sqlite3_column_text16($Statement, $Column)
  if ($pointer -eq [IntPtr]::Zero) { return $null }
  return [Runtime.InteropServices.Marshal]::PtrToStringUni($pointer)
}

function Get-ColumnBytes([IntPtr]$Statement, [int]$Column) {
  $length = [CliporaxWinSqlite]::sqlite3_column_bytes($Statement, $Column)
  if ($length -le 0) { return [byte[]]::new(0) }
  $pointer = [CliporaxWinSqlite]::sqlite3_column_blob($Statement, $Column)
  if ($pointer -eq [IntPtr]::Zero) { return [byte[]]::new(0) }
  $bytes = [byte[]]::new($length)
  [Runtime.InteropServices.Marshal]::Copy($pointer, $bytes, 0, $length)
  return $bytes
}

[IntPtr]$database = [IntPtr]::Zero
$pathPointer = New-Utf8Pointer $databasePath
try {
  $openResult = [CliporaxWinSqlite]::sqlite3_open_v2(
    $pathPointer,
    [ref]$database,
    1,
    [IntPtr]::Zero
  )
  if ($openResult -ne 0) {
    throw "Could not open the Ditto database read-only: $(Get-SqliteError $database)"
  }
  [void][CliporaxWinSqlite]::sqlite3_busy_timeout($database, 5000)

  $countSql = @"
SELECT COUNT(*)
FROM Main m
WHERE COALESCE(m.bIsGroup, 0) = 0
  AND EXISTS (
    SELECT 1 FROM Data d
    WHERE d.lParentID = m.lID
      AND d.strClipBoardFormat IN ('CF_UNICODETEXT', 'CF_TEXT')
  )
"@
  $countStatement = Open-Statement $database $countSql
  try {
    if ([CliporaxWinSqlite]::sqlite3_step($countStatement) -ne 100) {
      throw "Could not count Ditto clipboard history: $(Get-SqliteError $database)"
    }
    [long]$total = [CliporaxWinSqlite]::sqlite3_column_int64($countStatement, 0)
  } finally {
    [void][CliporaxWinSqlite]::sqlite3_finalize($countStatement)
  }

  $queryLimit = $PageItems + 1
  $rowsSql = @"
SELECT m.mText, d.strClipBoardFormat, d.ooData
FROM Main m
JOIN Data d ON d.lID = (
  SELECT candidate.lID
  FROM Data candidate
  WHERE candidate.lParentID = m.lID
    AND candidate.strClipBoardFormat IN ('CF_UNICODETEXT', 'CF_TEXT')
  ORDER BY CASE candidate.strClipBoardFormat
    WHEN 'CF_UNICODETEXT' THEN 0
    ELSE 1
  END, candidate.lID
  LIMIT 1
)
WHERE COALESCE(m.bIsGroup, 0) = 0
ORDER BY COALESCE(m.lDate, 0) ASC, m.lID ASC
LIMIT $queryLimit OFFSET $Offset
"@
  $rowsStatement = Open-Statement $database $rowsSql
  [int]$scanned = 0
  [int]$skipped = 0
  [int]$outputBytes = 0
  $hasMore = $false
  try {
    while (($step = [CliporaxWinSqlite]::sqlite3_step($rowsStatement)) -eq 100) {
      if ($scanned -ge $PageItems) {
        $hasMore = $true
        break
      }
      $preview = Get-ColumnText $rowsStatement 0
      $format = Get-ColumnText $rowsStatement 1
      $data = Get-ColumnBytes $rowsStatement 2
      if ($format -eq "CF_UNICODETEXT") {
        $text = [Text.Encoding]::Unicode.GetString($data).TrimEnd([char]0)
      } elseif ($format -eq "CF_TEXT") {
        $text = [Text.Encoding]::Default.GetString($data).TrimEnd([char]0)
        if ([string]::IsNullOrWhiteSpace($text)) { $text = $preview }
      } else {
        $text = $preview
      }

      $scanned += 1
      if ([string]::IsNullOrWhiteSpace($text)) {
        $skipped += 1
        continue
      }
      $textBytes = [Text.Encoding]::UTF8.GetByteCount($text)
      if ($textBytes -gt 1048576) {
        $skipped += 1
        continue
      }
      $line = ([ordered]@{ text = $text } | ConvertTo-Json -Compress)
      $lineBytes = [Text.Encoding]::UTF8.GetByteCount($line) + 1
      if (($outputBytes + $lineBytes) -gt $OutputBudget) {
        $scanned -= 1
        $hasMore = $true
        break
      }
      [Console]::Out.WriteLine($line)
      $outputBytes += $lineBytes
    }
    if ($step -ne 101 -and $step -ne 100) {
      throw "Could not read Ditto clipboard history: $(Get-SqliteError $database)"
    }
  } finally {
    [void][CliporaxWinSqlite]::sqlite3_finalize($rowsStatement)
  }

  $nextOffset = $Offset + $scanned
  $done = (-not $hasMore) -and ($nextOffset -ge $total)
  $metadata = [ordered]@{
    __cliporax_ditto = 1
    scanned = $scanned
    skipped = $skipped
    total = $total
    done = $done
    nextOffset = $(if ($done) { $null } else { $nextOffset })
  } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($metadata)
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($pathPointer)
  if ($database -ne [IntPtr]::Zero) {
    [void][CliporaxWinSqlite]::sqlite3_close($database)
  }
  if ($temporaryDatabase) {
    Remove-Item -LiteralPath $temporaryDatabase -Force -ErrorAction SilentlyContinue
  }
}
`;

function bytesToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function createDittoPowerShellArguments(
  sourcePath: string | undefined,
  offset: number,
  pageItems = DITTO_PAGE_ITEMS,
): string[] {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("Ditto pagination offset is invalid.");
  }
  if (!Number.isInteger(pageItems) || pageItems < 1 || pageItems > DITTO_PAGE_ITEMS) {
    throw new Error("Ditto page size is invalid.");
  }
  const payload = bytesToBase64(JSON.stringify({
    script: DITTO_POWERSHELL_SCRIPT,
    sourcePath: sourcePath?.trim() || null,
    offset,
    pageItems,
    outputBudget: DITTO_OUTPUT_BUDGET_BYTES,
  }));
  const chunks = payload.match(/.{1,3000}/g) ?? [];
  const commandParts = chunks.map((chunk, index) => `${index ? "+" : ""}'${chunk}'`);
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$b=",
    ...commandParts,
    POWERSHELL_DECODER,
  ];
}

export function parseDittoPage(stdout: string): DittoPage {
  const records: DittoPage["records"] = [];
  let metadata: DittoMetadata | undefined;
  let malformed = 0;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.__cliporax_ditto === 1) {
        metadata = value as unknown as DittoMetadata;
      } else if (typeof value.text === "string" && value.text.trim()) {
        records.push({ type: "text", content: value.text });
      } else {
        malformed += 1;
      }
    } catch {
      malformed += 1;
    }
  }

  if (!metadata) {
    throw new Error("Ditto exporter did not return pagination metadata.");
  }
  const { scanned, skipped, total, done, nextOffset } = metadata;
  if (
    !Number.isInteger(scanned) || scanned < 0
    || !Number.isInteger(skipped) || skipped < 0
    || !Number.isInteger(total) || total < 0
    || typeof done !== "boolean"
    || (!done && (!Number.isInteger(nextOffset) || (nextOffset ?? -1) < 0))
  ) {
    throw new Error("Ditto exporter returned invalid pagination metadata.");
  }
  return {
    records,
    scanned,
    skipped: skipped + malformed,
    total,
    done,
    nextOffset: done ? undefined : nextOffset ?? undefined,
  };
}

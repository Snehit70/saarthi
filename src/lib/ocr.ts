export interface TextMatch {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

function parseWords(tsv: string): Array<{ match: TextMatch; line: string }> {
  const lines = tsv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const out: Array<{ match: TextMatch; line: string }> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split("\t");
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    const text = cols[11]?.trim() ?? "";
    const geometry = cols.slice(6, 10).map(Number);
    if (
      cols[0] !== "5" ||
      !text ||
      !Number.isFinite(conf) ||
      conf < 0 ||
      conf > 100 ||
      geometry.some((n) => !Number.isFinite(n)) ||
      geometry[0] < 0 ||
      geometry[1] < 0 ||
      geometry[2] <= 0 ||
      geometry[3] <= 0
    )
      continue;
    out.push({
      line: cols.slice(1, 5).join(":"),
      match: {
        text,
        x: Number(cols[6]),
        y: Number(cols[7]),
        width: Number(cols[8]),
        height: Number(cols[9]),
        confidence: conf,
      },
    });
  }
  return out;
}

export function parseTesseractTsv(tsv: string): TextMatch[] {
  return parseWords(tsv).map((word) => word.match);
}

/** Match phrases on one OCR line without joining distant controls. */
export function findTesseractMatches(tsv: string, query: string, confidenceMin: number): TextMatch[] {
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const needle = normalize(query);
  if (!needle) return [];
  const words = parseWords(tsv);
  if (!needle.includes(" "))
    return words
      .map((word) => word.match)
      .filter((word) => word.confidence >= confidenceMin && normalize(word.text).includes(needle));
  const lines = new Map<string, TextMatch[]>();
  for (const word of words) {
    const line = lines.get(word.line) ?? [];
    line.push(word.match);
    lines.set(word.line, line);
  }
  const matches: TextMatch[] = [];
  for (const line of lines.values())
    for (let start = 0; start < line.length; start += 1) {
      const span: TextMatch[] = [];
      for (let end = start; end < line.length; end += 1) {
        const word = line[end];
        const previous = span.at(-1);
        if (
          word.confidence < confidenceMin ||
          (previous && word.x - previous.x - previous.width > 3 * Math.max(word.height, previous.height))
        )
          break;
        span.push(word);
        const text = span.map((part) => part.text).join(" ");
        const normalized = normalize(text);
        if (normalized.includes(needle)) {
          const x = Math.min(...span.map((part) => part.x));
          const y = Math.min(...span.map((part) => part.y));
          matches.push({
            text,
            x,
            y,
            width: Math.max(...span.map((part) => part.x + part.width)) - x,
            height: Math.max(...span.map((part) => part.y + part.height)) - y,
            confidence: Math.min(...span.map((part) => part.confidence)),
          });
          break;
        }
        if (normalized.length >= needle.length) break;
      }
    }
  return matches;
}

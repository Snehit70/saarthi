export interface TextMatch {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export function parseTesseractTsv(tsv: string): TextMatch[] {
  const lines = tsv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const out: TextMatch[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split("\t");
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    const text = cols[11]?.trim() ?? "";
    if (!text || !Number.isFinite(conf)) continue;
    out.push({
      text,
      x: Number(cols[6]),
      y: Number(cols[7]),
      width: Number(cols[8]),
      height: Number(cols[9]),
      confidence: conf,
    });
  }
  return out;
}

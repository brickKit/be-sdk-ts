// I-JSON check (RFC 7493): JSON.parse already refuses NaN; this pass refuses duplicate member names.
export function hasDuplicateNames(text: string): boolean {
  let i = 0;
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i]!)) i++; };
  const str = (): string => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): boolean => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const names = new Set<string>();
      ws();
      if (text[i] === "}") return (i++, false);
      for (;;) {
        ws();
        const n = str();
        if (names.has(n)) return true;
        names.add(n);
        ws(); i++; // ':'
        if (value()) return true;
        ws();
        if (text[i++] === "}") return false;
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") return (i++, false);
      for (;;) {
        if (value()) return true;
        ws();
        if (text[i++] === "]") return false;
      }
    }
    if (c === '"') return (str(), false);
    while (i < text.length && !",]} \t\n\r".includes(text[i]!)) i++;
    return false;
  };
  return value();
}

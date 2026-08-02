/**
 * JASS lexer.
 *
 * JASS is line-oriented: a newline terminates a statement, so newlines are real
 * tokens rather than whitespace. Everything else is conventional.
 *
 * Deliberately tolerant about spacing because JassHelper output is minified in
 * places — `...[this]then` has no space before the keyword, so keywords are only
 * recognised on identifier boundaries.
 */

export type TokKind = "id" | "kw" | "int" | "real" | "str" | "op" | "nl" | "eof";

export interface Token {
  kind: TokKind;
  /** Raw lexeme for id/kw/op; decoded text for str; source text for numbers. */
  value: string;
  /** Numeric value for int/real tokens. */
  num?: number;
  line: number;
  col: number;
}

export const KEYWORDS: ReadonlySet<string> = new Set([
  "globals", "endglobals", "constant", "native", "type", "extends",
  "function", "takes", "returns", "endfunction", "local", "set", "call",
  "if", "then", "else", "elseif", "endif",
  "loop", "exitwhen", "endloop", "return", "array",
  "nothing", "true", "false", "null", "and", "or", "not", "debug",
]);

/** Multi-character operators, longest first so `==` wins over `=`. */
const OPERATORS = ["==", "!=", "<=", ">=", "=", "+", "-", "*", "/", "<", ">", ",", "(", ")", "[", "]"];

export class JassSyntaxError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(`${message} (line ${line}:${col})`);
    this.name = "JassSyntaxError";
    this.line = line;
    this.col = col;
  }
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isIdStart = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdPart = (c: string): boolean => isIdStart(c) || isDigit(c);

/**
 * Convert a four-character rawcode such as 'A000' into the integer Warcraft III
 * uses internally. Shorter literals are accepted and left-padded, matching the
 * behaviour of the original compiler.
 */
export function rawcodeToInt(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value << 8) | (text.charCodeAt(i) & 0xff);
  return value >>> 0;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;
  const n = source.length;

  const col = (): number => pos - lineStart + 1;
  const push = (kind: TokKind, value: string, startCol: number, num?: number): void => {
    const token: Token = { kind, value, line, col: startCol };
    if (num !== undefined) token.num = num;
    tokens.push(token);
  };

  while (pos < n) {
    const c = source[pos];

    // Spaces and tabs separate tokens but carry no meaning.
    if (c === " " || c === "\t" || c === "\r") { pos++; continue; }

    if (c === "\n") {
      push("nl", "\\n", col());
      pos++; line++; lineStart = pos;
      continue;
    }

    // Line comment.
    if (c === "/" && source[pos + 1] === "/") {
      while (pos < n && source[pos] !== "\n") pos++;
      continue;
    }

    const startCol = col();

    // Identifier or keyword.
    if (isIdStart(c)) {
      const start = pos;
      while (pos < n && isIdPart(source[pos])) pos++;
      const word = source.slice(start, pos);
      push(KEYWORDS.has(word) ? "kw" : "id", word, startCol);
      continue;
    }

    // Rawcode literal: 'A000' -> integer.
    if (c === "'") {
      const start = ++pos;
      while (pos < n && source[pos] !== "'") {
        if (source[pos] === "\n") throw new JassSyntaxError("unterminated rawcode literal", line, startCol);
        pos++;
      }
      if (pos >= n) throw new JassSyntaxError("unterminated rawcode literal", line, startCol);
      const text = source.slice(start, pos);
      pos++; // closing quote
      push("int", `'${text}'`, startCol, rawcodeToInt(text));
      continue;
    }

    // String literal.
    if (c === '"') {
      const start = ++pos;
      let decoded = "";
      while (pos < n && source[pos] !== '"') {
        if (source[pos] === "\\") {
          const next = source[pos + 1];
          if (next === "n") decoded += "\n";
          else if (next === "r") decoded += "\r";
          else if (next === "t") decoded += "\t";
          else if (next === "\\") decoded += "\\";
          else if (next === '"') decoded += '"';
          else decoded += next;
          pos += 2;
          continue;
        }
        if (source[pos] === "\n") throw new JassSyntaxError("unterminated string literal", line, startCol);
        decoded += source[pos];
        pos++;
      }
      if (pos >= n) throw new JassSyntaxError("unterminated string literal", line, startCol);
      pos++; // closing quote
      const token: Token = { kind: "str", value: decoded, line, col: startCol };
      tokens.push(token);
      void start;
      continue;
    }

    // Hexadecimal: 0xFF or $FF.
    if ((c === "0" && (source[pos + 1] === "x" || source[pos + 1] === "X")) || c === "$") {
      const start = pos;
      pos += c === "$" ? 1 : 2;
      const digitsStart = pos;
      while (pos < n && /[0-9a-fA-F]/.test(source[pos])) pos++;
      if (pos === digitsStart) throw new JassSyntaxError("malformed hexadecimal literal", line, startCol);
      const text = source.slice(start, pos);
      push("int", text, startCol, parseInt(source.slice(digitsStart, pos), 16));
      continue;
    }

    // Decimal integer or real. A leading '.' is a real (".5").
    if (isDigit(c) || (c === "." && isDigit(source[pos + 1]))) {
      const start = pos;
      let isReal = false;
      while (pos < n && isDigit(source[pos])) pos++;
      if (source[pos] === ".") {
        isReal = true;
        pos++;
        while (pos < n && isDigit(source[pos])) pos++;
      }
      const text = source.slice(start, pos);
      push(isReal ? "real" : "int", text, startCol, parseFloat(text));
      continue;
    }

    // Operators.
    let matched = false;
    for (const op of OPERATORS) {
      if (source.startsWith(op, pos)) {
        push("op", op, startCol);
        pos += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    throw new JassSyntaxError(`unexpected character ${JSON.stringify(c)}`, line, startCol);
  }

  tokens.push({ kind: "eof", value: "<eof>", line, col: col() });
  return tokens;
}

/**
 * JASS parser — recursive descent over the token stream.
 *
 * Precedence, loosest to tightest:
 *   or  <  and  <  comparison  <  + -  <  * /  <  unary (not, -)  <  primary
 *
 * Note that JASS `and`/`or` do NOT short-circuit; that is a runtime concern and
 * is handled in the interpreter, but it is worth remembering when reading this.
 */

import { tokenize, JassSyntaxError } from "./lexer.ts";
import type { Token } from "./lexer.ts";
import type {
  Expr, Stmt, Program, FuncDecl, GlobalDecl, NativeDecl, TypeDecl, Param, CallExpr,
} from "./ast.ts";

const COMPARISON = new Set(["==", "!=", "<", ">", "<=", ">="]);

export class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  // -- token helpers ------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private at(kind: string, value?: string): boolean {
    const t = this.peek();
    return t.kind === kind && (value === undefined || t.value === value);
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private accept(kind: string, value?: string): Token | null {
    if (this.at(kind, value)) return this.next();
    return null;
  }

  private expect(kind: string, value?: string): Token {
    if (this.at(kind, value)) return this.next();
    const t = this.peek();
    const wanted = value !== undefined ? `'${value}'` : kind;
    throw new JassSyntaxError(`expected ${wanted} but found '${t.value}'`, t.line, t.col);
  }

  /** Consume any run of blank lines. */
  private skipNewlines(): void {
    while (this.at("nl")) this.next();
  }

  /** A statement ends at a newline (or end of file). */
  private endStatement(): void {
    if (this.at("eof")) return;
    this.expect("nl");
  }

  // -- program ------------------------------------------------------------

  parse(): Program {
    const program: Program = { globals: [], functions: [], natives: [], types: [] };

    this.skipNewlines();
    while (!this.at("eof")) {
      if (this.at("kw", "globals")) {
        this.parseGlobalsBlock(program.globals);
      } else if (this.at("kw", "type")) {
        program.types.push(this.parseTypeDecl());
      } else if (this.at("kw", "native") || (this.at("kw", "constant") && this.peek(1).value === "native")) {
        program.natives.push(this.parseNativeDecl());
      } else if (this.at("kw", "function") || (this.at("kw", "constant") && this.peek(1).value === "function")) {
        program.functions.push(this.parseFunction());
      } else {
        const t = this.peek();
        throw new JassSyntaxError(`unexpected '${t.value}' at top level`, t.line, t.col);
      }
      this.skipNewlines();
    }
    return program;
  }

  private parseTypeDecl(): TypeDecl {
    const line = this.peek().line;
    this.expect("kw", "type");
    const name = this.expect("id").value;
    this.expect("kw", "extends");
    const base = this.next().value;
    this.endStatement();
    return { name, base, line };
  }

  private parseNativeDecl(): NativeDecl {
    const line = this.peek().line;
    const isConstant = this.accept("kw", "constant") !== null;
    this.expect("kw", "native");
    const name = this.next().value;
    const { params, returnType } = this.parseSignature();
    this.endStatement();
    return { name, params, returnType, isConstant, line };
  }

  private parseGlobalsBlock(out: GlobalDecl[]): void {
    this.expect("kw", "globals");
    this.endStatement();
    this.skipNewlines();

    while (!this.at("kw", "endglobals")) {
      if (this.at("eof")) {
        const t = this.peek();
        throw new JassSyntaxError("unterminated globals block", t.line, t.col);
      }
      const line = this.peek().line;
      const isConstant = this.accept("kw", "constant") !== null;
      const type = this.next().value;
      const isArray = this.accept("kw", "array") !== null;
      const name = this.next().value;

      let init: Expr | null = null;
      if (this.accept("op", "=")) init = this.parseExpr();

      out.push({ name, type, isArray, isConstant, init, line });
      this.endStatement();
      this.skipNewlines();
    }
    this.expect("kw", "endglobals");
  }

  private parseSignature(): { params: Param[]; returnType: string } {
    this.expect("kw", "takes");
    const params: Param[] = [];
    if (this.accept("kw", "nothing") === null) {
      do {
        const type = this.next().value;
        const name = this.next().value;
        params.push({ name, type });
      } while (this.accept("op", ","));
    }
    this.expect("kw", "returns");
    const returnType = this.next().value; // `nothing` or a type name
    return { params, returnType };
  }

  private parseFunction(): FuncDecl {
    const line = this.peek().line;
    const isConstant = this.accept("kw", "constant") !== null;
    this.expect("kw", "function");
    const name = this.next().value;
    const { params, returnType } = this.parseSignature();
    this.endStatement();

    const body = this.parseBlock(["endfunction"]);
    this.expect("kw", "endfunction");

    return { name, params, returnType, body, isConstant, line };
  }

  /** Parse statements until one of `terminators` is the current keyword. */
  private parseBlock(terminators: string[]): Stmt[] {
    const body: Stmt[] = [];
    this.skipNewlines();
    while (!this.at("eof")) {
      const t = this.peek();
      if (t.kind === "kw" && terminators.includes(t.value)) break;
      body.push(this.parseStatement());
      this.skipNewlines();
    }
    return body;
  }

  private parseStatement(): Stmt {
    // `debug` is a modifier; the statement behind it parses normally.
    this.accept("kw", "debug");

    const t = this.peek();
    const line = t.line;

    if (t.kind === "kw") {
      switch (t.value) {
        case "local": return this.parseLocal();
        case "set": return this.parseSet();
        case "call": {
          this.next();
          const call = this.parseCallExpr();
          this.endStatement();
          return { kind: "callStmt", call, line };
        }
        case "if": return this.parseIf();
        case "loop": return this.parseLoop();
        case "exitwhen": {
          this.next();
          const cond = this.parseExpr();
          this.endStatement();
          return { kind: "exitwhen", cond, line };
        }
        case "return": {
          this.next();
          const value = this.at("nl") || this.at("eof") ? null : this.parseExpr();
          this.endStatement();
          return { kind: "return", value, line };
        }
      }
    }

    throw new JassSyntaxError(`unexpected '${t.value}' where a statement was expected`, t.line, t.col);
  }

  private parseLocal(): Stmt {
    const line = this.peek().line;
    this.expect("kw", "local");
    const type = this.next().value;
    const isArray = this.accept("kw", "array") !== null;
    const name = this.next().value;
    let init: Expr | null = null;
    if (this.accept("op", "=")) init = this.parseExpr();
    this.endStatement();
    return { kind: "local", name, type, isArray, init, line };
  }

  private parseSet(): Stmt {
    const line = this.peek().line;
    this.expect("kw", "set");
    const name = this.next().value;

    if (this.accept("op", "[")) {
      const index = this.parseExpr();
      this.expect("op", "]");
      this.expect("op", "=");
      const value = this.parseExpr();
      this.endStatement();
      return { kind: "setIndex", name, index, value, line };
    }

    this.expect("op", "=");
    const value = this.parseExpr();
    this.endStatement();
    return { kind: "set", name, value, line };
  }

  private parseIf(): Stmt {
    const line = this.peek().line;
    this.expect("kw", "if");
    const cond = this.parseExpr();
    this.expect("kw", "then");
    this.endStatement();

    const then = this.parseBlock(["elseif", "else", "endif"]);
    const elifs: Array<{ cond: Expr; body: Stmt[] }> = [];
    let elseBody: Stmt[] | null = null;

    while (this.at("kw", "elseif")) {
      this.next();
      const elifCond = this.parseExpr();
      this.expect("kw", "then");
      this.endStatement();
      elifs.push({ cond: elifCond, body: this.parseBlock(["elseif", "else", "endif"]) });
    }

    if (this.accept("kw", "else")) {
      this.endStatement();
      elseBody = this.parseBlock(["endif"]);
    }

    this.expect("kw", "endif");
    this.endStatement();
    return { kind: "if", cond, then, elifs, else: elseBody, line };
  }

  private parseLoop(): Stmt {
    const line = this.peek().line;
    this.expect("kw", "loop");
    this.endStatement();
    const body = this.parseBlock(["endloop"]);
    this.expect("kw", "endloop");
    this.endStatement();
    return { kind: "loop", body, line };
  }

  // -- expressions --------------------------------------------------------

  parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.at("kw", "or")) {
      const line = this.next().line;
      left = { kind: "binary", op: "or", left, right: this.parseAnd(), line };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.at("kw", "and")) {
      const line = this.next().line;
      left = { kind: "binary", op: "and", left, right: this.parseComparison(), line };
    }
    return left;
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    while (this.peek().kind === "op" && COMPARISON.has(this.peek().value)) {
      const t = this.next();
      left = { kind: "binary", op: t.value, left, right: this.parseAdditive(), line: t.line };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.at("op", "+") || this.at("op", "-")) {
      const t = this.next();
      left = { kind: "binary", op: t.value, left, right: this.parseMultiplicative(), line: t.line };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.at("op", "*") || this.at("op", "/")) {
      const t = this.next();
      left = { kind: "binary", op: t.value, left, right: this.parseUnary(), line: t.line };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.at("kw", "not")) {
      const t = this.next();
      return { kind: "unary", op: "not", operand: this.parseUnary(), line: t.line };
    }
    if (this.at("op", "-")) {
      const t = this.next();
      return { kind: "unary", op: "-", operand: this.parseUnary(), line: t.line };
    }
    if (this.at("op", "+")) {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parseCallExpr(): CallExpr {
    const t = this.next(); // function name
    const line = t.line;
    this.expect("op", "(");
    const args: Expr[] = [];
    if (!this.at("op", ")")) {
      do { args.push(this.parseExpr()); } while (this.accept("op", ","));
    }
    this.expect("op", ")");
    return { kind: "call", name: t.value, args, line };
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    const line = t.line;

    if (t.kind === "int") { this.next(); return { kind: "int", value: t.num!, line }; }
    if (t.kind === "real") { this.next(); return { kind: "real", value: t.num!, line }; }
    if (t.kind === "str") { this.next(); return { kind: "str", value: t.value, line }; }

    if (t.kind === "kw") {
      if (t.value === "true" || t.value === "false") {
        this.next();
        return { kind: "bool", value: t.value === "true", line };
      }
      if (t.value === "null") { this.next(); return { kind: "null", line }; }
      if (t.value === "function") {
        this.next();
        const name = this.next().value;
        return { kind: "funcref", name, line };
      }
    }

    if (this.accept("op", "(")) {
      const inner = this.parseExpr();
      this.expect("op", ")");
      return inner;
    }

    if (t.kind === "id") {
      // Function call, array access, or plain variable.
      if (this.peek(1).kind === "op" && this.peek(1).value === "(") return this.parseCallExpr();
      if (this.peek(1).kind === "op" && this.peek(1).value === "[") {
        this.next();
        this.expect("op", "[");
        const index = this.parseExpr();
        this.expect("op", "]");
        return { kind: "index", name: t.value, index, line };
      }
      this.next();
      return { kind: "var", name: t.value, line };
    }

    throw new JassSyntaxError(`unexpected '${t.value}' in expression`, t.line, t.col);
  }
}

export function parseJass(source: string): Program {
  return new Parser(source).parse();
}

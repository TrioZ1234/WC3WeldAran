/**
 * JASS abstract syntax tree.
 *
 * Node shapes stay close to the grammar so the parser reads like the language
 * reference and the interpreter can walk the tree without a lowering pass.
 */

export type Expr =
  | IntLit | RealLit | StrLit | BoolLit | NullLit
  | VarRef | ArrayRef | CallExpr | FuncRef | Binary | Unary;

export interface IntLit { kind: "int"; value: number; line: number }
export interface RealLit { kind: "real"; value: number; line: number }
export interface StrLit { kind: "str"; value: string; line: number }
export interface BoolLit { kind: "bool"; value: boolean; line: number }
export interface NullLit { kind: "null"; line: number }

export interface VarRef { kind: "var"; name: string; line: number }
export interface ArrayRef { kind: "index"; name: string; index: Expr; line: number }
export interface CallExpr { kind: "call"; name: string; args: Expr[]; line: number }
/** `function Foo` used as a value — a `code` handle. */
export interface FuncRef { kind: "funcref"; name: string; line: number }
export interface Binary { kind: "binary"; op: string; left: Expr; right: Expr; line: number }
export interface Unary { kind: "unary"; op: string; operand: Expr; line: number }

export type Stmt =
  | SetStmt | SetArrayStmt | CallStmt | IfStmt | LoopStmt
  | ExitWhenStmt | ReturnStmt | LocalStmt;

export interface SetStmt { kind: "set"; name: string; value: Expr; line: number }
export interface SetArrayStmt { kind: "setIndex"; name: string; index: Expr; value: Expr; line: number }
export interface CallStmt { kind: "callStmt"; call: CallExpr; line: number }
export interface IfStmt {
  kind: "if";
  cond: Expr;
  then: Stmt[];
  /** `elseif` chains, in source order. */
  elifs: Array<{ cond: Expr; body: Stmt[] }>;
  else: Stmt[] | null;
  line: number;
}
export interface LoopStmt { kind: "loop"; body: Stmt[]; line: number }
export interface ExitWhenStmt { kind: "exitwhen"; cond: Expr; line: number }
export interface ReturnStmt { kind: "return"; value: Expr | null; line: number }
/** A local declaration; kept in the statement stream to preserve initialiser order. */
export interface LocalStmt {
  kind: "local";
  name: string;
  type: string;
  isArray: boolean;
  init: Expr | null;
  line: number;
}

export interface Param { name: string; type: string }

export interface FuncDecl {
  name: string;
  params: Param[];
  returnType: string;
  body: Stmt[];
  isConstant: boolean;
  line: number;
}

export interface GlobalDecl {
  name: string;
  type: string;
  isArray: boolean;
  isConstant: boolean;
  init: Expr | null;
  line: number;
}

export interface NativeDecl {
  name: string;
  params: Param[];
  returnType: string;
  isConstant: boolean;
  line: number;
}

export interface TypeDecl { name: string; base: string; line: number }

export interface Program {
  globals: GlobalDecl[];
  functions: FuncDecl[];
  natives: NativeDecl[];
  types: TypeDecl[];
}

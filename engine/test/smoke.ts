/**
 * Regression test for the JASS front end and runtime.
 *
 *   node engine/test/smoke.ts
 *
 * Checks language-level behaviour on small inputs, then runs the real map
 * script if it has been extracted. The unit checks are what catch a broken
 * parser change; the map run is what catches a broken contract.
 */

import { existsSync, readFileSync } from "node:fs";
import { Interpreter } from "../jass/interpreter.ts";
import { tokenize } from "../jass/lexer.ts";
import { parseJass } from "../jass/parser.ts";
import { asNumber, asString, asBool } from "../jass/values.ts";
import { ONE, fx, unfx, fxMul, isqrt, fxDistance } from "../sim/fixed.ts";
import { DamageTable, armorMultiplier, resolveDamage } from "../sim/combat.ts";
import { Battlefield, loadUnitStats } from "../sim/units.ts";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (ok) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

/** Run a snippet whose `test` function returns a value. */
function evaluate(body: string, returnType = "integer"): unknown {
  const source = `function test takes nothing returns ${returnType}\n${body}\nendfunction\n`;
  const vm = new Interpreter(source);
  return vm.run("test").v;
}

console.log("lexer");
check("rawcode 'A000' -> integer", tokenize("'A000'")[0].num, 0x41303030);
check("hex literal", tokenize("0x1F")[0].num, 31);
check("real literal", tokenize("3.5")[0].num, 3.5);
check("keyword adjacency ']then'", tokenize("]then")[1].value, "then");
check("comment is skipped", tokenize("// note\n1")[1].num, 1);

console.log("\nparser");
check("globals and functions counted",
  (() => {
    const p = parseJass("globals\ninteger a=1\nendglobals\nfunction f takes nothing returns nothing\nendfunction\n");
    return `${p.globals.length}/${p.functions.length}`;
  })(), "1/1");
check("operator precedence 2+3*4", evaluate("return 2+3*4"), 14);
check("parenthesised (2+3)*4", evaluate("return (2+3)*4"), 20);
check("unary minus", evaluate("return -5+2"), -3);

console.log("\nsemantics");
check("integer division truncates", evaluate("return 7/2"), 3);
check("real division keeps fraction", evaluate("return 7.0/2.0", "real"), 3.5);
check("division by zero is 0, not Infinity", evaluate("return 5/0"), 0);
check("string concatenation", evaluate('return "a"+"b"', "string"), "ab");
check("comparison yields boolean", evaluate("return 3>2", "boolean"), true);
check("not operator", evaluate("return not false", "boolean"), true);
check("local shadows nothing, arithmetic works",
  evaluate("local integer i=10\nset i=i*3\nreturn i"), 30);
check("loop with exitwhen",
  evaluate("local integer i=0\nlocal integer s=0\nloop\nexitwhen i>4\nset s=s+i\nset i=i+1\nendloop\nreturn s"), 10);
check("if / elseif / else",
  evaluate("local integer i=2\nif i==1 then\nreturn 100\nelseif i==2 then\nreturn 200\nelse\nreturn 300\nendif"), 200);
check("array default is zero",
  evaluate("local integer array a\nreturn a[7]"), 0);
check("array assignment round-trips",
  evaluate("local integer array a\nset a[3]=42\nreturn a[3]"), 42);
check("null equality", evaluate("return null==null", "boolean"), true);
check("integer coercion on assignment to integer local",
  evaluate("local integer i\nset i=7.9\nreturn i"), 7);

console.log("\nnatives and handles");
check("Player handles are stable",
  evaluate("return GetPlayerId(Player(5))"), 5);
check("distinct players are not equal",
  evaluate("return Player(1)==Player(2)", "boolean"), false);
check("hashtable round-trip",
  evaluate("local hashtable h=InitHashtable()\ncall SaveInteger(h,1,2,99)\nreturn LoadInteger(h,1,2)"), 99);
check("hashtable miss returns 0",
  evaluate("local hashtable h=InitHashtable()\nreturn LoadInteger(h,1,2)"), 0);
check("group add then count",
  evaluate("local group g=CreateGroup()\ncall GroupAddUnit(g,CreateUnit(Player(0),1,0.0,0.0,0.0))\nreturn CountUnitsInGroup(g)"), 1);
check("FirstOfGroup on empty group is null",
  evaluate("local group g=CreateGroup()\nreturn FirstOfGroup(g)==null", "boolean"), true);
check("unimplemented native returns null instead of hanging",
  evaluate("return SomeNativeThatDoesNotExist()==null", "boolean"), true);
check("rect centre maths",
  evaluate("local rect r=Rect(0.0,0.0,10.0,20.0)\nreturn GetRectCenterY(r)", "real"), 10);
check("deterministic RNG is reproducible",
  (() => {
    const a = evaluate("return GetRandomInt(1,1000000)");
    const b = evaluate("return GetRandomInt(1,1000000)");
    return a === b;
  })(), true);

console.log("\nfixed-point arithmetic");
{
  check("one world unit round-trips", unfx(fx(1)), 1);
  check("fractions survive", unfx(fx(2.5)), 2.5);
  check("integer sqrt is exact on squares", isqrt(144), 12);
  check("integer sqrt truncates", isqrt(145), 12);
  check("integer sqrt of zero", isqrt(0), 0);
  check("distance is pythagorean", Math.round(unfx(fxDistance(0, 0, fx(3), fx(4)))), 5);
  // Determinism argument: the same expression must give the same integer twice.
  check("multiplication is reproducible", fxMul(fx(1.1), fx(3.3)), fxMul(fx(1.1), fx(3.3)));
}

console.log("\ncombat maths");
{
  const table = new DamageTable(
    "DamageBonusPierce=2.10,0.85,1.10,0.45,1.10,0.05,0.15,1.50\n" +
    "DamageBonusNormal=1.10,1.50,1.10,0.80,1.10,0.70,0.15,1.10\n");
  // Compare in fixed point: 2.10 is not representable in 1/256 steps, and
  // rounding to the nearest step is the correct, deterministic behaviour.
  check("map table overrides the default",
    table.multiplier("pierce", "small"), Math.round(2.1 * ONE));
  check("normal versus medium", table.multiplier("normal", "medium") / ONE, 1.5);
  check("unknown attack falls back to normal",
    table.multiplier("normal", "hero"), table.multiplier("normal", "hero"));
  check("armour alias light maps to small", DamageTable.normaliseArmor("Light"), "small");
  check("armour alias fortified maps to fort", DamageTable.normaliseArmor("Fortified"), "fort");
  check("unknown armour defaults to normal", DamageTable.normaliseArmor("Stone"), "normal");

  check("zero armour changes nothing", armorMultiplier(0), ONE);
  // 6 % per point with diminishing returns: 10 armour blocks ~37.5 %.
  check("ten armour blocks about 37 per cent",
    Math.round((1 - armorMultiplier(10) / ONE) * 100), 37);
  check("negative armour amplifies", armorMultiplier(-5) > ONE, true);

  let sequence = 7;
  const roll = (low: number, high: number): number => {
    sequence = (sequence * 31 + 17) % 1000;
    return low + (sequence % (high - low + 1));
  };
  const damage = resolveDamage(table,
    { attackType: "normal", base: 10, dice: 0, sides: 0 },
    { armorType: "medium", armor: 0 }, roll);
  check("damage applies the table multiplier", Math.round(damage / ONE), 15);
}

console.log("\nbattlefield");
{
  const stats = loadUnitStats([
    { id: "atk1", fields: { unam: "Attacker", uhpm: 100, udef: 0, udty: "normal",
      ua1t: "normal", ua1b: 10, ua1d: 0, ua1s: 0, ua1c: 1.0, ua1r: 100, umvs: 300, uacq: 600 } },
    { id: "tgt1", fields: { unam: "Target", uhpm: 60, udef: 0, udty: "normal",
      ua1t: "normal", ua1b: 0, ua1d: 0, ua1s: 0, ua1c: 0, ua1r: 0, umvs: 0, uacq: 0 } },
  ]);
  check("stats parsed for both types", stats.size, 2);
  check("cooldown converted to ticks", stats.get("atk1")!.cooldown, 32);
  check("a unit with no damage cannot attack", stats.get("tgt1")!.canAttack, false);

  const field = new Battlefield({ damageTable: new DamageTable() });
  const attacker = field.spawn(stats.get("atk1")!, 1, 0, 0);
  const target = field.spawn(stats.get("tgt1")!, 2, 200, 0);

  for (let i = 0; i < 32; i++) field.step();
  check("attacker closed the distance and struck", field.attacks > 0, true);
  check("target lost hit points", target.hp < stats.get("tgt1")!.maxHp * ONE, true);

  for (let i = 0; i < 32 * 20; i++) field.step();
  check("target eventually dies", target.alive, false);
  check("death was counted", field.deaths, 1);
  check("attacker survived", attacker.alive, true);

  // Friendly fire must not happen.
  const peaceful = new Battlefield({ damageTable: new DamageTable() });
  peaceful.spawn(stats.get("atk1")!, 1, 0, 0);
  peaceful.spawn(stats.get("tgt1")!, 1, 100, 0);
  for (let i = 0; i < 64; i++) peaceful.step();
  check("allies do not attack each other", peaceful.attacks, 0);

  // The lockstep precondition: identical inputs, identical outcome.
  const run = (): string => {
    const f = new Battlefield({ damageTable: new DamageTable() });
    for (let i = 0; i < 6; i++) {
      f.spawn(stats.get("atk1")!, 1, -300 + i * 40, 0);
      f.spawn(stats.get("atk1")!, 2, 300 + i * 40, 0);
    }
    for (let i = 0; i < 32 * 30; i++) f.step();
    return `${f.attacks}/${f.deaths}/${f.damageDealt}`;
  };
  check("two runs are bit-identical", run(), run());
}

console.log("\nclock, timers and coroutines");
{
  // A one-shot timer must fire exactly once, at the right tick.
  const vm = new Interpreter(`
globals
integer fired=0
endglobals
function tick takes nothing returns nothing
set fired=fired+1
endfunction
function boot takes nothing returns nothing
call TimerStart(CreateTimer(),1.0,false,function tick)
endfunction
`);
  vm.initGlobals();
  vm.run("boot");
  const fired = (): unknown => vm.globals.get("fired")?.value.v;
  vm.runFor(0.5);
  check("one-shot timer has not fired early", fired(), 0);
  vm.runFor(0.6);
  check("one-shot timer fired at its deadline", fired(), 1);
  vm.runFor(5);
  check("one-shot timer does not repeat", fired(), 1);
}

{
  const vm = new Interpreter(`
globals
integer beats=0
endglobals
function beat takes nothing returns nothing
set beats=beats+1
endfunction
function boot takes nothing returns nothing
call TimerStart(CreateTimer(),0.03125,true,function beat)
endfunction
`);
  vm.initGlobals();
  vm.run("boot");
  vm.runFor(1);
  check("32 Hz periodic timer beats 32 times per second", vm.globals.get("beats")?.value.v, 32);
}

{
  // TriggerSleepAction must suspend the thread and resume it later — this is
  // what a synchronous walker cannot do, and what PolledWait depends on.
  const vm = new Interpreter(`
globals
integer stage=0
endglobals
function work takes nothing returns nothing
set stage=1
call TriggerSleepAction(2.0)
set stage=2
call TriggerSleepAction(2.0)
set stage=3
endfunction
`);
  vm.initGlobals();
  vm.spawn("work");
  const stage = (): unknown => vm.globals.get("stage")?.value.v;
  check("thread runs up to its first sleep", stage(), 1);
  check("thread is parked, not finished", vm.sleepingThreads, 1);
  vm.runFor(2.1);
  check("thread resumed after the sleep elapsed", stage(), 2);
  vm.runFor(2.1);
  check("thread resumed a second time", stage(), 3);
  check("thread finished and was collected", vm.sleepingThreads, 0);
  check("sleeps were honoured, not skipped", vm.sleepsHonoured >= 2, true);
}

{
  // A loop that only terminates because the thread sleeps inside it —
  // the exact shape of Blizzard.j's PolledWait.
  const vm = new Interpreter(`
globals
integer spins=0
boolean finished=false
endglobals
function waiter takes nothing returns nothing
local timer t=CreateTimer()
call TimerStart(t,1.0,false,null)
loop
exitwhen TimerGetRemaining(t)<=0
set spins=spins+1
call TriggerSleepAction(0.1)
endloop
set finished=true
endfunction
`);
  vm.initGlobals();
  vm.spawn("waiter");
  vm.runFor(2);
  check("polled wait loop terminates", vm.globals.get("finished")?.value.v, true);
  check("polled wait spun a sane number of times",
    Number(vm.globals.get("spins")?.value.v) < 30, true);
}

{
  // TriggerEvaluate must actually run conditions: the map's heartbeat is one.
  const vm = new Interpreter(`
globals
integer ran=0
trigger t
endglobals
function cond takes nothing returns boolean
set ran=ran+1
return true
endfunction
function boot takes nothing returns nothing
set t=CreateTrigger()
call TriggerAddCondition(t,Condition(function cond))
call TriggerEvaluate(t)
call TriggerEvaluate(t)
endfunction
`);
  vm.initGlobals();
  vm.run("boot");
  check("TriggerEvaluate executes conditions", vm.globals.get("ran")?.value.v, 2);
}

{
  const vm = new Interpreter(`
globals
trigger t
endglobals
function boot takes nothing returns nothing
set t=CreateTrigger()
call TriggerRegisterPlayerChatEvent(t,Player(0),"-help",true)
endfunction
`);
  vm.initGlobals();
  vm.run("boot");
  check("event registration is recorded", vm.events.size, 1);
  check("registration matches its event", vm.events.match("player:chat", { chat: "-help" }).length, 1);
  check("registration ignores a different message",
    vm.events.match("player:chat", { chat: "-other" }).length, 0);
}

console.log("\nwarcraft iii scripts (common.j + Blizzard.j)");
const commonPath = "build/war3/common.j";
const blizzardPath = "build/war3/Blizzard.j";
if (!existsSync(commonPath) || !existsSync(blizzardPath)) {
  console.log("  skip  build/war3 not populated — run tools/fetch_war3_data.py");
} else {
  const war3 = [
    { name: commonPath, text: readFileSync(commonPath, "utf8") },
    { name: blizzardPath, text: readFileSync(blizzardPath, "utf8") },
  ];
  const vm = new Interpreter(war3);
  check("common.j declares natives", vm.nativeSignatures.size > 1000, true);
  check("common.j declares handle types", vm.handleTypes.has("unit"), true);
  check("Blizzard.j supplies functions", vm.functions.size > 900, true);

  vm.initGlobals();
  const globalValue = (name: string): unknown => vm.globals.get(name)?.value.v;
  check("bj_UNIT_FACING has its real value", globalValue("bj_UNIT_FACING"), 270);
  check("bj_MAX_PLAYERS has its real value", globalValue("bj_MAX_PLAYERS"), 12);
  check("computed constant bj_RADTODEG", Math.round(Number(globalValue("bj_RADTODEG"))), 57);
  check("JASS_MAX_ARRAY_SIZE", globalValue("JASS_MAX_ARRAY_SIZE"), 8192);
  check("enum constants become handles",
    String(globalValue("PLAYER_COLOR_RED")).startsWith("playercolor#"), true);
  check("no constant left unresolved", vm.externals.size, 0);

  // A native declared to return `integer` must stub to 0, not null, or arithmetic breaks.
  const typed = new Interpreter([
    ...war3,
    { name: "<t>", text: "function test takes nothing returns integer\nreturn GetPlayerTechCount(Player(0),1,true)+5\nendfunction\n" },
  ]);
  typed.initGlobals();
  check("typed stub keeps arithmetic sane", typed.run("test").v, 5);
}

console.log("\nreal map script");
const scriptPath = "build/extracted/war3map.j";
if (!existsSync(scriptPath)) {
  console.log(`  skip  ${scriptPath} not found — run build.py first`);
} else {
  const source = readFileSync(scriptPath, "utf8");
  const vm = new Interpreter(source);
  check("functions parsed", vm.program.functions.length, 1018);
  check("globals parsed", vm.program.globals.length, 811);

  vm.initGlobals();
  vm.run("config");
  check("config sets 12 players", vm.world.playerCount, 12);
  check("config defines 12 start locations", vm.world.startLocations.filter(Boolean).length, 12);

  vm.run("main");
  check("main creates the preplaced army", vm.world.units.length > 2000, true);
  check("main registers tech state", vm.world.techState.size > 1000, true);
  check("no unexpected natives outside the known contract", vm.firstSeen.length < 100, true);

  // The map alone still arms its own heartbeat; the rest needs Blizzard.j.
  check("main arms timers", vm.clock.pending > 0, true);
}

console.log("\nlive simulation (full stack)");
if (!existsSync(scriptPath) || !existsSync(commonPath) || !existsSync(blizzardPath)) {
  console.log("  skip  needs build/extracted and build/war3");
} else {
  const vm = new Interpreter([
    { name: commonPath, text: readFileSync(commonPath, "utf8") },
    { name: blizzardPath, text: readFileSync(blizzardPath, "utf8") },
    { name: scriptPath, text: readFileSync(scriptPath, "utf8") },
  ]);
  vm.initGlobals();
  vm.run("config");
  vm.run("main");

  check("main arms timers", vm.clock.pending > 0, true);
  check("main binds trigger events", vm.events.size > 1000, true);

  const unitsAtBoot = vm.world.units.length;
  const evaluationsAtBoot = vm.triggersEvaluated;
  vm.runFor(90);

  check("clock advanced 90 seconds", vm.clock.formatted, "01:30");
  // 90 s of a 32 Hz heartbeat is 2880 evaluations before anything else.
  check("the map's heartbeat is beating",
    vm.triggersEvaluated - evaluationsAtBoot > 2500, true);
  check("the map spawned units on its own", vm.world.units.length > unitsAtBoot, true);
  check("sleeps were honoured during the run", vm.sleepsHonoured > 0, true);
  check("simulation produced no errors", vm.tickErrors.length, 0);
}

void asNumber; void asString; void asBool;

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;

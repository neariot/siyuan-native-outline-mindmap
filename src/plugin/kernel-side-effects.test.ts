/**
 * Kernel side effects: every probe is green, yet the kernel changed the data.
 *
 * Corresponds to .logs/API-GOTCHAS.md §102 / §103 / §104.
 *
 * ★ Core point: `code:0` only means "the transaction was accepted", **not that the result matches expectations**.
 *   And some damage is **not on the plugin side at all** —— every stage of the plugin is correct,
 *   yet the kernel still changes other places while it processes the transaction.
 */
export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

console.log('=== §102 the semantics of previousID change with the structure the anchor sits in ===');
{
  /** The behaviour of the same call when the child list is absent / present */
  type Behaviour = 'nested-ok' | 'flat-silent' | 'overwrite';
  const withParentParagraph = (childListExists: boolean): Behaviour =>
    childListExists ? 'overwrite' : 'flat-silent';

  check('child list absent → silently lands at the top level (not nested)', withParentParagraph(false) === 'flat-silent');
  check('★★ child list present → it enters the child list but **overwrites** the existing item', withParentParagraph(true) === 'overwrite');
  check('★ the two cases behave differently ⇒ the semantics are not a stable "insert after"', withParentParagraph(false) !== withParentParagraph(true));

  // Switch to another anchor type
  const withParentListItem = (): Behaviour => 'flat-silent';
  check('★ with the parent listItem as anchor → no data loss, but it lands in the wrong place', withParentListItem() === 'flat-silent');

  const all: Behaviour[] = [withParentParagraph(false), withParentParagraph(true), withParentListItem()];
  check(
    '★★★ **No anchor form** can guarantee "correct position" + "no data loss" at the same time',
    !all.includes('nested-ok'),
  );
}

console.log('\n=== §103 anchor resolution fails → silently lands at the top level ===');
{
  interface InsResult {
    code: number;
    /** The type of the returned block ID. ★ Not fixed! */
    returnedType: 'l' | 'i' | '';
    /** Where it actually landed */
    landedAt: 'top' | 'child' | 'nowhere';
  }
  const anchorUnresolved: InsResult = { code: 0, returnedType: '', landedAt: 'top' };
  const anchorOk: InsResult = { code: 0, returnedType: 'i', landedAt: 'child' };

  check('★★ "invalid anchor" and "valid anchor" return **exactly the same** code', anchorUnresolved.code === anchorOk.code);
  check(
    '★★ yet they land in different places ⇒ looking at the code alone cannot detect the failure',
    anchorUnresolved.landedAt !== anchorOk.landedAt,
  );
  check(
    '★ the only reliable predicate is reading the structure back afterwards (getBlockKramdown)',
    anchorUnresolved.landedAt === 'top' && anchorOk.landedAt === 'child',
  );
}

console.log('\n=== §104 the return type of insertBlock is not fixed ===');
{
  /**
   * Creating a **new** list returns a List `l`;
   * appending to an **existing** list returns a listItem `i`.
   * Treating it as a listItem every time → namespace mismatch (same family as §92).
   */
  const createdNewList = (): 'l' | 'i' => 'l';
  const appendedToExisting = (): 'l' | 'i' => 'i';

  check('★ creating a list → returns **List** `l`', createdNewList() === 'l');
  check('★ appending to an existing list → returns **listItem** `i`', appendedToExisting() === 'i');
  check(
    '★★ the return type is not fixed ⇒ callers cannot treat it as a listItem every time',
    createdNewList() !== appendedToExisting(),
  );

  // parentID does not accept a List
  const acceptedParentKinds = new Set(['listItem', 'doc', 'heading']);
  check('★ parentID accepts listItem / document / heading', acceptedParentKinds.has('listItem') && acceptedParentKinds.has('doc'));
  check('★★ parentID does **not** accept a List (measured code:-1)', !acceptedParentKinds.has('list'));
}

console.log('\n=== Methodology: every probe is green but the store changed → suspect the kernel, do not keep digging through your own code ===');
{
  interface ProbeReport {
    anchor: boolean;
    tree: boolean;
    blockIds: boolean;
    text: boolean;
    deletions: boolean;
  }
  /** Measured probe results for the #53 scenario */
  const allGreen: ProbeReport = { anchor: true, tree: true, blockIds: true, text: true, deletions: false };
  const pluginIsInnocent = Object.entries(allGreen)
    .filter(([k]) => k !== 'deletions')
    .every(([, v]) => v);

  check('★ all four probes are green: anchor / tree / block IDs / text', pluginIsInnocent);
  check('★ syncDeletions **never fired once** (rules out a plugin deletion)', allGreen.deletions === false);
  check(
    '★★ yet the 子T block **completely vanished** from the store ⇒ the culprit is inside the kernel',
    pluginIsInnocent && allGreen.deletions === false,
  );

  // The reverse: the wrong investigation direction must be recorded too, to avoid repeating it
  const wrongHypothesis = 'dump blockMap 看两个节点是否指向同一个块';
  check(
    '★ the mistaken hypothesis this round disproved: the two block IDs are actually **indeed different**',
    wrongHypothesis.includes('同一个块'),
  );
}

console.log('\n=== The trade-off: the insert only has to avoid data loss, the position is left to moveNodes ===');
{
  /**
   * Since no anchor satisfies both conditions at once,
   * the strategy should be: pick the one that **does not lose data** (even if the position is wrong),
   * then let moveNodes correct the position.
   */
  interface Strategy {
    name: string;
    losesData: boolean;
    positionRight: boolean;
  }
  const strategies: Strategy[] = [
    { name: 'parentID=List', losesData: false, positionRight: true }, // but code:-1, unusable
    { name: 'previousID=父段落块', losesData: true, positionRight: true },
    { name: 'previousID=父listItem', losesData: false, positionRight: false },
    { name: 'previousID=兄弟段落块', losesData: true, positionRight: true },
  ];
  const usable = strategies.filter((s) => s.name !== 'parentID=List');

  const noLoss = usable.filter((s) => !s.losesData);
  check('★ among the usable forms, **only one** avoids data loss', noLoss.length === 1);
  check('★ it = previousID=父listItem', noLoss[0].name === 'previousID=父listItem');
  check(
    '★★ but its position is wrong ⇒ it **must** fall back on moveNodes',
    noLoss[0].positionRight === false,
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);

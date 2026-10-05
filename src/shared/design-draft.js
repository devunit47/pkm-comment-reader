// The design editor's draft: a copy of the applied design that changes only in
// memory, with an undo history, until it is applied in a single save.
export const MAX_HISTORY = 100;

// Key order differs between normalized and spread objects; compare content only.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const sameDesign = (a, b) => canonical(a) === canonical(b);

// `design` is the applied design and `revision` the one it was read at; the
// apply step sends that revision so a newer design elsewhere is never replaced.
export function createDraftSession(design, revision, { limit = MAX_HISTORY } = {}) {
  let start, draft, base, undoStack, redoStack, open, stale;
  function reset(next, nextRevision) {
    start = structuredClone(next); draft = structuredClone(next); base = nextRevision;
    undoStack = []; redoStack = []; open = null; stale = false;
  }
  reset(design, revision);

  const session = {
    get design() { return draft; },
    get start() { return start; },
    get revision() { return base; },
    get dirty() { return !sameDesign(draft, start); },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    get stale() { return stale; },
    // Records one edit. Calls with the same `merge` key extend the open
    // operation (a drag, typing, held keys) until seal() closes it.
    change(next, { label = '', ratio = null, merge = null } = {}) {
      if (sameDesign(next, draft)) return false;
      next = structuredClone(next);
      if (merge !== null && open && open.merge === merge) open.after = next;
      else {
        session.seal();
        undoStack.push({ before: draft, after: next, label, ratio, merge });
        if (undoStack.length > limit) undoStack.splice(0, undoStack.length - limit);
        if (merge !== null) open = undoStack.at(-1);
      }
      redoStack = [];
      draft = next;
      return true;
    },
    seal() {
      // An operation that ended where it began leaves no history entry.
      if (open && sameDesign(open.before, open.after) && undoStack.at(-1) === open) undoStack.pop();
      open = null;
    },
    // A cancelled pointer gesture returns to where it began without history.
    cancelOpen() {
      if (!open) return false;
      if (undoStack.at(-1) === open) { undoStack.pop(); draft = open.before; }
      open = null;
      return true;
    },
    undo() {
      session.seal();
      const entry = undoStack.pop();
      if (!entry) return null;
      redoStack.push(entry); draft = entry.before;
      return { label: entry.label, ratio: entry.ratio };
    },
    redo() {
      session.seal();
      const entry = redoStack.pop();
      if (!entry) return null;
      undoStack.push(entry); draft = entry.after;
      return { label: entry.label, ratio: entry.ratio };
    },
    // Back to the opening content; the editor stays open and the history ends.
    // A stale draft stays stale: only restart() reads the newer design.
    discard() { const wasStale = stale; reset(start, base); stale = wasStale; },
    // Another page changed the design. The draft stays for reading but can
    // only be replaced, never applied over the newer design.
    markStale() { stale = true; },
    restart(next, nextRevision) { reset(next, nextRevision); },
  };
  return session;
}

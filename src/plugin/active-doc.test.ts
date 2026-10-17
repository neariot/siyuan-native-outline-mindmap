// Acceptance and regression tests for active document ID resolution (active-doc.ts).
//
// Verifies multi-tiered resilience across desktop layouts, detached window modes,
// transitional layout states, lazy-loaded tabs, and mobile editors.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import './test-dom-shim';
import { getActiveDocId } from './active-doc';

type MutableGlobal = {
  siyuan?: Record<string, unknown>;
  document?: {
    querySelector: (selector: string) => {
      getAttribute: (name: string) => string | null;
    } | null;
  };
  location?: { pathname?: string; search?: string; hash?: string };
};

/** Set `location` the way the implementation reads it (`globalThis`), for one test. */
function setLocation(v: { pathname?: string; search?: string; hash?: string }): void {
  Object.defineProperty(globalThis, 'location', { value: v, configurable: true, writable: true });
}

const g = globalThis as unknown as MutableGlobal;

test('getActiveDocId returns empty string when no siyuan environment is present', () => {
  const origSiyuan = g.siyuan;
  try {
    delete g.siyuan;
    assert.equal(getActiveDocId(), '');
  } finally {
    g.siyuan = origSiyuan;
  }
});

test('getActiveDocId resolves rootID from standard centerLayout via active DOM tab', () => {
  const origSiyuan = g.siyuan;
  const origDoc = g.document;
  try {
    const docId = '20261013120000-v000001';
    g.document = {
      querySelector: (selector: string) => {
        if (selector === '.layout__wnd--active .item--focus') {
          return { getAttribute: (attr: string) => (attr === 'data-id' ? 'tab-1' : null) };
        }
        return null;
      },
    };
    g.siyuan = {
      layout: {
        centerLayout: {
          children: [
            {
              id: 'tab-1',
              model: {
                editor: {
                  protyle: {
                    block: { rootID: docId },
                  },
                },
              },
            },
          ],
        },
      },
    };

    assert.equal(getActiveDocId(), docId);
  } finally {
    g.siyuan = origSiyuan;
    g.document = origDoc;
  }
});

test('getActiveDocId resolves rootID during transitional dock state when layout__wnd--active is missing', () => {
  const origSiyuan = g.siyuan;
  const origDoc = g.document;
  try {
    const docId = '20261013120000-v000002';
    // When dock opens, .layout__wnd--active disappears temporarily
    g.document = {
      querySelector: () => null,
    };
    g.siyuan = {
      layout: {
        centerLayout: {
          children: [
            {
              id: 'tab-focused',
              headElement: {
                classList: {
                  contains: (cls: string) => cls === 'item--focus',
                },
              },
              model: {
                editor: {
                  protyle: {
                    block: { rootID: docId },
                  },
                },
              },
            },
          ],
        },
      },
    };

    assert.equal(getActiveDocId(), docId);
  } finally {
    g.siyuan = origSiyuan;
    g.document = origDoc;
  }
});

test('getActiveDocId resolves rootID in detached window mode where layout.layout is the root', () => {
  const origSiyuan = g.siyuan;
  const origDoc = g.document;
  try {
    const docId = '20261013120000-v000003';
    g.document = {
      querySelector: (selector: string) => {
        if (selector === '.layout__wnd--active .item--focus') {
          return { getAttribute: (attr: string) => (attr === 'data-id' ? 'popout-tab' : null) };
        }
        return null;
      },
    };
    // Detached popout window has no centerLayout; its root is layout.layout
    g.siyuan = {
      layout: {
        layout: {
          children: [
            {
              id: 'popout-tab',
              model: {
                editor: {
                  protyle: {
                    block: { rootID: docId },
                  },
                },
              },
            },
          ],
        },
      },
    };

    assert.equal(getActiveDocId(), docId);
  } finally {
    g.siyuan = origSiyuan;
    g.document = origDoc;
  }
});

test('getActiveDocId extracts rootId from data-initdata when model is still initializing', () => {
  const origSiyuan = g.siyuan;
  const origDoc = g.document;
  try {
    const docId = '20261013120000-v000004';
    g.document = {
      querySelector: (selector: string) => {
        if (selector === '.layout__wnd--active .item--focus') {
          return { getAttribute: (attr: string) => (attr === 'data-id' ? 'lazy-tab' : null) };
        }
        return null;
      },
    };
    // Model not yet attached, but headElement holds data-initdata (matching SiYuan setHeader.ts)
    g.siyuan = {
      layout: {
        centerLayout: {
          children: [
            {
              id: 'lazy-tab',
              headElement: {
                getAttribute: (attr: string) =>
                  attr === 'data-initdata'
                    ? JSON.stringify({ instance: 'Editor', rootId: docId })
                    : null,
              },
            },
          ],
        },
      },
    };

    assert.equal(getActiveDocId(), docId);
  } finally {
    g.siyuan = origSiyuan;
    g.document = origDoc;
  }
});

test('getActiveDocId falls back to protyle options.rootId when block.rootID is not yet populated', () => {
  const origSiyuan = g.siyuan;
  const origDoc = g.document;
  try {
    const docId = '20261013120000-v000005';
    g.document = {
      querySelector: (selector: string) => {
        if (selector === '.layout__wnd--active .item--focus') {
          return { getAttribute: (attr: string) => (attr === 'data-id' ? 'tab-opt' : null) };
        }
        return null;
      },
    };
    g.siyuan = {
      layout: {
        centerLayout: {
          children: [
            {
              id: 'tab-opt',
              model: {
                editor: {
                  protyle: {
                    options: { rootId: docId },
                  },
                },
              },
            },
          ],
        },
      },
    };

    assert.equal(getActiveDocId(), docId);
  } finally {
    g.siyuan = origSiyuan;
    g.document = origDoc;
  }
});

test('getActiveDocId resolves from mobile editors (editor, popEditor, protyle)', () => {
  const origSiyuan = g.siyuan;
  const origDoc = g.document;
  try {
    g.document = { querySelector: () => null };

    // Mobile primary editor
    g.siyuan = {
      mobile: {
        editor: { protyle: { block: { rootID: '20261013120000-v000006' } } },
      },
    };
    assert.equal(getActiveDocId(), '20261013120000-v000006');

    // Mobile popEditor
    g.siyuan = {
      mobile: {
        popEditor: { protyle: { block: { rootID: '20261013120000-v000007' } } },
      },
    };
    assert.equal(getActiveDocId(), '20261013120000-v000007');

    // Mobile direct protyle
    g.siyuan = {
      mobile: {
        protyle: { block: { rootID: '20261013120000-v000008' } },
      },
    };
    assert.equal(getActiveDocId(), '20261013120000-v000008');
  } finally {
    g.siyuan = origSiyuan;
    g.document = origDoc;
  }
});

// ★★ The mobile URL is the last resort, and the reported failure is precisely that the
//   globals miss: on a real iOS Safari none of `window.mobile.*` is populated, so the panel
//   mounted against no document at all (measured: rows rendered, default title, code block
//   absent — nothing read from the document the user was actually looking at).
//
//   The criterion is not "the URL parses" but "the id the URL carries wins only when nothing
//   else answered", because a stale `?id=` on a desktop tab must never outvote the layout tree.
test('getActiveDocId resolves from the mobile shell URL when the mobile globals are empty', () => {
  const origSiyuan = g.siyuan;
  const origDoc = g.document;
  const origLoc = globalThis.location;
  try {
    const docId = '20261016050000-v000009';
    g.document = { querySelector: () => null };
    // A mobile shell with an editor that has booted no protyle yet: every global path empty.
    g.siyuan = { mobile: { editor: {}, popEditor: {}, protyle: {} } };
    setLocation({ pathname: '/stage/build/mobile/', search: `?id=${docId}`, hash: '' });
    assert.equal(getActiveDocId(), docId);
  } finally {
    g.siyuan = origSiyuan;
    g.document = origDoc;
    Object.defineProperty(globalThis, 'location', { value: origLoc, configurable: true, writable: true });
  }
});

test('★ the desktop layout outranks a stale ?id= in the address', () => {
  const origSiyuan = g.siyuan;
  const origDoc = g.document;
  const origLoc = globalThis.location;
  try {
    const desktopId = '20261016050000-v000010';
    g.document = {
      querySelector: (selector: string) => {
        if (selector === '.layout__wnd--active .item--focus') {
          return { getAttribute: (attr: string) => (attr === 'data-id' ? 'tab-1' : null) };
        }
        return null;
      },
    };
    g.siyuan = {
      layout: {
        centerLayout: {
          children: [{ id: 'tab-1', model: { editor: { protyle: { block: { rootID: desktopId } } } } }],
        },
      },
    };
    setLocation({ pathname: '/stage/build/desktop/', search: '?id=20260101000000-vstale01', hash: '' });
    assert.equal(getActiveDocId(), desktopId);
  } finally {
    g.siyuan = origSiyuan;
    g.document = origDoc;
    Object.defineProperty(globalThis, 'location', { value: origLoc, configurable: true, writable: true });
  }
});

test('★ an id-shaped value that is not one is not adopted', () => {
  const origSiyuan = g.siyuan;
  const origDoc = g.document;
  const origLoc = globalThis.location;
  try {
    g.document = { querySelector: () => null };
    g.siyuan = { mobile: {} };
    // A stray `?id=` that is not a SiYuan root id must be left alone, not adopted.
    setLocation({ pathname: '/stage/build/mobile/', search: '?id=abc', hash: '' });
    assert.equal(getActiveDocId(), '');
  } finally {
    g.siyuan = origSiyuan;
    g.document = origDoc;
    Object.defineProperty(globalThis, 'location', { value: origLoc, configurable: true, writable: true });
  }
});

test('getActiveDocId does not guess when tab is non-editor (asset / search)', () => {
  const origSiyuan = g.siyuan;
  const origDoc = g.document;
  try {
    g.document = {
      querySelector: (selector: string) => {
        if (selector === '.layout__wnd--active .item--focus') {
          return { getAttribute: (attr: string) => (attr === 'data-id' ? 'search-tab' : null) };
        }
        return null;
      },
    };
    g.siyuan = {
      layout: {
        centerLayout: {
          children: [
            {
              id: 'search-tab',
              headElement: {
                getAttribute: (attr: string) =>
                  attr === 'data-initdata'
                    ? JSON.stringify({ instance: 'Search', k: 'query' })
                    : null,
              },
            },
          ],
        },
      },
    };

    assert.equal(getActiveDocId(), '');
  } finally {
    g.siyuan = origSiyuan;
    g.document = origDoc;
  }
});

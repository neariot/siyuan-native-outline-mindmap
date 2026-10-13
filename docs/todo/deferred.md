# Deferred Capabilities & Design Constraints

> Technical rationales for features deliberately postponed or constrained by architecture.

## 1. Free Positioning of Mind-Map Nodes

### Context
In the mind-map view, dragging a node to arbitrary blank space is currently a no-op: the node snaps back to its computed layout position upon drop.

### Rationale for Deferral
- **Algorithmic conflict**: Node coordinates are dynamically derived at render time by layout engines (`layoutHorizontal` and `layoutOrg` in `src/core/layout.ts`). Free placement requires storing explicit $(x, y)$ coordinate offsets.
- **Zero custom attribute discipline**: The plugin stores all data in native SiYuan Protyle blocks (`d -> l -> i -> p`) with zero custom attributes (`custom-* = 0`). Storing per-node visual coordinates would require introducing custom attributes or metadata storage that diverges from native blocks.
- **Demand assessment**: Deferred until there is concrete demand for unconstrained canvas diagrams. See `docs/MAPPING.md` §0.1.

---

## 2. Canvas-Level Exact Sibling Ordering

### Context
In the mind-map canvas, dropping a node onto another node attaches it as a child. It does not provide precise drop indicators for inserting between specific siblings.

### Rationale for Constraint
- **Role separation**: The mind-map view is optimized for broad topological visualization, branch restructuring, and ideation.
- **Outline view specialization**: Fine-grained sibling ordering, exact line-by-line repositioning, and multi-node selection are first-class operations in the outline editor view (`Outliner.tsx`), which features dedicated drop-target indicators and keyboard shortcuts.
- Documented in `docs/MAPPING.md` §0.1 as a deliberate design boundary.

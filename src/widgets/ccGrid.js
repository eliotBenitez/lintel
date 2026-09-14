// SPDX-License-Identifier: GPL-2.0-or-later
//
// CCGrid — the module grid at the top of the Control Center.
//
// Tahoe composes those modules on a grid of four cells per row, grouped in two
// halves: 62px circles with a 16px gap inside a half, a 12px gutter between the
// halves (62 + 16 + 62 = 140, 140 + 12 + 140 = 292). A control takes one of
// three shapes — a circle (1×1), a capsule filling a half (2×1), or Now
// Playing's square (2×2) — and the user can resize and reorder them.
//
// Modules flow into the first free cells in reading order (dense, row-major,
// the way macOS fills its own grid), so a control the machine lacks or the user
// removed never leaves a hole in the middle. A capsule or square whose other
// half stays empty across all its rows grows to the full width instead of
// leaving that half blank.
//
// Placement is a layout manager over direct children, not nested boxes, so
// rearranging never re-parents an actor (which would drop hover and key focus).
// The gaps are read from stylesheet.css (`.lintel-cc-grid`).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const COLUMNS = 4;

export const SHAPES = Object.freeze({
    small: {columns: 1, rows: 1},
    wide: {columns: 2, rows: 1},
    large: {columns: 2, rows: 2},
});

/**
 * Put every module in the first free cells, row-major, that fit its shape.
 * Two-column shapes only start at a half's edge, so a capsule never straddles
 * the gutter.
 *
 * @param {Array<{shape?: string}>} modules in reading order
 * @returns {Array<{module: object, row: number, column: number,
 *   columns: number, rows: number}>}
 */
export function packModules(modules) {
    const taken = [];
    const free = (row, column, columns, rows) => {
        for (let r = row; r < row + rows; r++) {
            for (let c = column; c < column + columns; c++) {
                if (taken[r]?.[c])
                    return false;
            }
        }
        return true;
    };
    const take = (row, column, columns, rows) => {
        for (let r = row; r < row + rows; r++) {
            taken[r] ??= new Array(COLUMNS).fill(false);
            for (let c = column; c < column + columns; c++)
                taken[r][c] = true;
        }
    };

    const placements = [];
    for (const module of modules) {
        const {columns, rows} = SHAPES[module.shape] ?? SHAPES.wide;
        const step = columns === 1 ? 1 : 2;
        let placed = false;
        // Terminates: a row below every placement so far is always free.
        for (let row = 0; !placed; row++) {
            for (let column = 0; column < COLUMNS && !placed; column += step) {
                if (!free(row, column, columns, rows))
                    continue;
                take(row, column, columns, rows);
                placements.push({module, row, column, columns, rows});
                placed = true;
            }
        }
    }

    // A half-width module next to an empty half takes the whole row.
    for (const placement of placements) {
        if (placement.columns !== 2)
            continue;
        const other = placement.column === 0 ? 2 : 0;
        if (!free(placement.row, other, 2, placement.rows))
            continue;
        take(placement.row, other, 2, placement.rows);
        placement.column = 0;
        placement.columns = COLUMNS;
    }

    return placements;
}

const CCGridLayout = GObject.registerClass(
class CCGridLayout extends Clutter.LayoutManager {
    _init() {
        super._init();
        this._placements = [];
    }

    setPlacements(placements) {
        this._placements = placements;
        this.layout_changed();
    }

    _length(container, name, fallback) {
        const node = container.peek_theme_node?.();
        if (!node)
            return fallback;
        const [found, value] = node.lookup_length(name, false);
        return found ? value : fallback;
    }

    /** Column offsets, cell width and row heights for a given width. */
    _geometry(container, width) {
        const gutter = this._length(container, '-lintel-grid-gutter', 12);
        const pairGap = this._length(container, '-lintel-grid-pair-gap', 16);
        const rowGap = this._length(container, '-lintel-grid-row-gap', 8);
        const half = Math.max(0, (width - gutter) / 2);
        const cell = Math.max(0, (half - pairGap) / 2);
        const x = [0, cell + pairGap, half + gutter, half + gutter + cell + pairGap];
        const spanWidth = p => x[p.column + p.columns - 1] + cell - x[p.column];

        const shown = this._placements.filter(p => p.module.actor.visible);
        const rowCount = shown.reduce((n, p) => Math.max(n, p.row + p.rows), 0);
        const heights = new Array(rowCount).fill(0);
        for (const p of shown) {
            if (p.rows !== 1)
                continue;
            // A circle is a square cell whatever its content asks for: its
            // natural height is only the glyph's.
            const height = p.columns === 1
                ? cell
                : p.module.actor.get_preferred_height(spanWidth(p))[1];
            heights[p.row] = Math.max(heights[p.row], height);
        }
        for (const p of shown) {
            if (p.rows === 1)
                continue;
            const [, natural] = p.module.actor.get_preferred_height(spanWidth(p));
            const rows = heights.slice(p.row, p.row + p.rows);
            const have = rows.reduce((sum, h) => sum + h, 0) + rowGap * (p.rows - 1);
            const extra = Math.max(0, natural - have) / p.rows;
            for (let r = p.row; r < p.row + p.rows; r++)
                heights[r] += extra;
        }

        const y = [];
        let offset = 0;
        for (let r = 0; r < rowCount; r++) {
            y.push(offset);
            offset += heights[r] + rowGap;
        }
        const total = rowCount ? offset - rowGap : 0;
        return {x, y, cell, heights, rowGap, spanWidth, shown, total};
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        // The popup's content box fixes the width (stylesheet.css).
        return [0, 0];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const width = forWidth >= 0 ? forWidth : container.width;
        const {total} = this._geometry(container, width);
        return [total, total];
    }

    vfunc_allocate(container, box) {
        const geometry = this._geometry(container, box.get_width());
        const {x, y, cell, heights, rowGap, spanWidth} = geometry;
        for (const p of geometry.shown) {
            const width = spanWidth(p);
            let height = heights.slice(p.row, p.row + p.rows)
                .reduce((sum, h) => sum + h, 0) + rowGap * (p.rows - 1);
            let top = y[p.row];
            if (p.columns === 1 && height > cell) {
                top += (height - cell) / 2;
                height = cell;
            }
            const child = new Clutter.ActorBox();
            child.set_origin(box.x1 + x[p.column], box.y1 + top);
            child.set_size(width, height);
            p.module.actor.allocate(child);
        }
    }
});

export const CCGrid = GObject.registerClass(
class CCGrid extends St.Widget {
    _init() {
        super._init({
            style_class: 'lintel-cc-grid',
            layout_manager: new CCGridLayout(),
            x_expand: true,
        });
    }

    /**
     * Lay the modules out in reading order; hidden ones take no cell. Each
     * actor becomes a child of the grid the first time it is laid out, and
     * stays one.
     *
     * @param {Array<{actor: Clutter.Actor, shape?: string}>} modules
     * @returns {Array} the placements, for callers that need the geometry
     */
    setModules(modules) {
        for (const {actor} of modules) {
            const parent = actor.get_parent();
            if (parent === this)
                continue;
            parent?.remove_child(actor);
            this.add_child(actor);
        }
        const placements = packModules(
            modules.filter(module => module.actor.visible));
        this.layout_manager.setPlacements(placements);
        return placements;
    }
});

// Item stacks and the player inventory. A stack is { id, count, dmg?, data? }:
// dmg is used durability for tools, data carries per-item state (explorer map target).
import { maxStack, ITEMS } from './items.js';

export const HOTBAR = 9;
export const SLOTS = 36;

export const cloneStack = (s) => (s ? { ...s, data: s.data ? { ...s.data } : undefined } : null);

export function canMerge(a, b) {
  if (!a || !b || a.id !== b.id) return false;
  if (maxStack(a.id) <= 1) return false;
  return !a.dmg && !b.dmg && !a.data && !b.data;
}

// Merge `src` into the slot array (preferring existing partial stacks), in index order.
// Returns what is left of the stack (or null).
export function addToSlots(slots, src, order = null) {
  if (!src) return null;
  const s = cloneStack(src);
  const idx = order ?? slots.map((_, i) => i);
  const max = maxStack(s.id);
  for (const i of idx) {
    const t = slots[i];
    if (t && canMerge(t, s) && t.count < max) {
      const n = Math.min(max - t.count, s.count);
      t.count += n;
      s.count -= n;
      if (s.count <= 0) return null;
    }
  }
  for (const i of idx) {
    if (!slots[i]) {
      const n = Math.min(max, s.count);
      slots[i] = { ...s, count: n };
      s.count -= n;
      if (s.count <= 0) return null;
    }
  }
  return s;
}

export class Inventory {
  constructor() {
    this.slots = new Array(SLOTS).fill(null);
    this.selected = 0;
  }

  get held() {
    return this.slots[this.selected];
  }

  set held(stack) {
    this.slots[this.selected] = stack;
  }

  // Adds a stack, hotbar first. Returns the leftover (null if everything fit).
  add(stack) {
    return addToSlots(this.slots, stack);
  }

  canFit(stack) {
    const copy = this.slots.map(cloneStack);
    return addToSlots(copy, stack) === null;
  }

  count(id) {
    return this.slots.reduce((n, s) => n + (s?.id === id ? s.count : 0), 0);
  }

  consumeHeld(n = 1) {
    const h = this.held;
    if (!h) return;
    h.count -= n;
    if (h.count <= 0) this.held = null;
  }

  // Damage the held tool; returns true if it broke.
  damageHeld(amount = 1) {
    const h = this.held;
    const max = h ? ITEMS[h.id]?.durability : 0;
    if (!max) return false;
    h.dmg = (h.dmg ?? 0) + amount;
    if (h.dmg >= max) {
      this.held = null;
      return true;
    }
    return false;
  }

  clear() {
    this.slots.fill(null);
  }

  serialize() {
    return { slots: this.slots.map(cloneStack), selected: this.selected };
  }

  load(data) {
    this.slots = new Array(SLOTS).fill(null);
    (data?.slots ?? []).forEach((s, i) => {
      if (s && ITEMS[s.id] && i < SLOTS) this.slots[i] = s;
    });
    this.selected = data?.selected ?? 0;
  }
}

// Minecraft-style click on a slot. Mutates slots[i]; returns the new cursor stack.
// button 0 = left (pick up / place all / swap), 2 = right (half / one).
export function clickSlot(slots, i, cursor, button, accepts = () => true) {
  const slot = slots[i];
  if (!cursor) {
    if (!slot) return null;
    if (button === 2) {
      const take = Math.ceil(slot.count / 2);
      const picked = { ...cloneStack(slot), count: take };
      slot.count -= take;
      if (slot.count <= 0) slots[i] = null;
      return picked;
    }
    slots[i] = null;
    return slot;
  }
  if (!accepts(cursor)) return cursor;
  if (!slot) {
    if (button === 2) {
      slots[i] = { ...cloneStack(cursor), count: 1 };
      cursor.count -= 1;
      return cursor.count > 0 ? cursor : null;
    }
    slots[i] = cursor;
    return null;
  }
  if (canMerge(slot, cursor)) {
    const max = maxStack(slot.id);
    const n = Math.min(button === 2 ? 1 : cursor.count, max - slot.count);
    slot.count += n;
    cursor.count -= n;
    return cursor.count > 0 ? cursor : null;
  }
  slots[i] = cursor;
  return slot;
}

export type LayoutPageGeometry = {
  estimatedHeight: number;
  id: string;
};

export type LayoutPageMeasurement = {
  height: number;
  id: string;
  widthEpoch: number;
};

export type PageGeometrySnapshot = {
  heights: readonly number[];
  pageIds: readonly string[];
  widthEpoch: number;
};

class FenwickTree {
  #values: number[] = [];

  reset(values: readonly number[]): void {
    this.#values = new Array(values.length + 1).fill(0);
    for (let index = 0; index < values.length; index += 1) {
      this.add(index, values[index] ?? 0);
    }
  }

  add(index: number, delta: number): void {
    for (let cursor = index + 1; cursor < this.#values.length; cursor += cursor & -cursor) {
      this.#values[cursor] = (this.#values[cursor] ?? 0) + delta;
    }
  }

  prefixSum(endExclusive: number): number {
    let total = 0;
    for (let cursor = Math.min(endExclusive, this.#values.length - 1); cursor > 0; cursor -= cursor & -cursor) {
      total += this.#values[cursor] ?? 0;
    }
    return total;
  }
}

function positiveHeight(height: number): number {
  return Number.isFinite(height) && height > 0 ? height : 1;
}

export class PageGeometry {
  #fenwick = new FenwickTree();
  #heights: number[] = [];
  #ids: string[] = [];
  #indices = new Map<string, number>();
  #widthEpoch = 0;

  reset(pages: readonly LayoutPageGeometry[], widthEpoch: number): void {
    this.#ids = [];
    this.#heights = [];
    this.#indices.clear();
    for (const [index, page] of pages.entries()) {
      if (this.#indices.has(page.id)) {
        throw new Error(`duplicate layout page ID: ${page.id}`);
      }
      this.#ids.push(page.id);
      this.#heights.push(positiveHeight(page.estimatedHeight));
      this.#indices.set(page.id, index);
    }
    this.#fenwick.reset(this.#heights);
    this.#widthEpoch = widthEpoch;
  }

  replace(pages: readonly LayoutPageGeometry[], widthEpoch: number): void {
    const retainedHeights =
      widthEpoch === this.#widthEpoch
        ? new Map(this.#ids.map((id, index) => [id, this.#heights[index] ?? 1]))
        : new Map<string, number>();
    this.reset(
      pages.map((page) => ({
        estimatedHeight: retainedHeights.get(page.id) ?? page.estimatedHeight,
        id: page.id,
      })),
      widthEpoch,
    );
  }

  append(pages: readonly LayoutPageGeometry[]): void {
    if (pages.length === 0) {
      return;
    }
    const combined = this.#ids.map((id, index) => ({estimatedHeight: this.#heights[index] ?? 1, id}));
    this.reset([...combined, ...pages], this.#widthEpoch);
  }

  totalHeight(): number {
    return this.#fenwick.prefixSum(this.#heights.length);
  }

  heightBefore(pageId: string): number | null {
    const index = this.#indices.get(pageId);
    return index === undefined ? null : this.#fenwick.prefixSum(index);
  }

  heightForPage(pageId: string): number | null {
    const index = this.#indices.get(pageId);
    return index === undefined ? null : (this.#heights[index] ?? null);
  }

  positionForPage(pageId: string): number | null {
    return this.heightBefore(pageId);
  }

  pageAt(position: number): string | null {
    if (this.#ids.length === 0) {
      return null;
    }
    const target = Math.max(0, Math.min(position, Math.max(0, this.totalHeight() - 1)));
    let low = 0;
    let high = this.#ids.length - 1;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.#fenwick.prefixSum(middle + 1) > target) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return this.#ids[low] ?? null;
  }

  updateMeasurement(measurement: LayoutPageMeasurement): boolean {
    if (measurement.widthEpoch !== this.#widthEpoch) {
      return false;
    }
    const index = this.#indices.get(measurement.id);
    if (index === undefined) {
      return false;
    }
    const height = positiveHeight(measurement.height);
    const previous = this.#heights[index] ?? 1;
    if (previous === height) {
      return false;
    }
    this.#heights[index] = height;
    this.#fenwick.add(index, height - previous);
    return true;
  }

  beginWidthEpoch(widthEpoch: number): void {
    this.#widthEpoch = widthEpoch;
  }

  snapshot(): PageGeometrySnapshot {
    return {heights: [...this.#heights], pageIds: [...this.#ids], widthEpoch: this.#widthEpoch};
  }
}

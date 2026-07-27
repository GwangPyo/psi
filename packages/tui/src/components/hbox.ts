import type { Component } from "../tui.ts";
import { visibleWidth } from "../utils.ts";

export class HBox implements Component {
	private left: Component;
	private right: Component;
	private leftRatio: number;
	private gap: number;

	constructor(left: Component, right: Component, leftRatio = 0.5, gap = 2) {
		this.left = left;
		this.right = right;
		this.leftRatio = leftRatio;
		this.gap = gap;
	}

	invalidate(): void {
		this.left.invalidate?.();
		this.right.invalidate?.();
	}

	render(width: number): string[] {
		const availableWidth = Math.max(0, width - this.gap);
		const leftWidth = Math.floor(availableWidth * this.leftRatio);
		const rightWidth = availableWidth - leftWidth;

		const leftLines = this.left.render(leftWidth);
		const rightLines = this.right.render(rightWidth);

		const result: string[] = [];
		const maxLines = Math.max(leftLines.length, rightLines.length);
		const gapStr = " ".repeat(this.gap);

		for (let i = 0; i < maxLines; i++) {
			const leftLine = leftLines[i] ?? "";
			const rightLine = rightLines[i] ?? "";

			const leftVisLen = visibleWidth(leftLine);
			const leftPad = " ".repeat(Math.max(0, leftWidth - leftVisLen));

			result.push(leftLine + leftPad + gapStr + rightLine);
		}

		return result;
	}
}

import { BatchCollector } from '../migration/batch.js';
import type { BatchProgress } from '../migration/batch.js';
import type { MigrationScan, OtpAccount } from '../types.js';

/**
 * The offline app's state, kept separate from anything that touches the DOM.
 *
 * Plain functions over a plain object, with one subscriber callback. No
 * framework: this ships as a single HTML file that has to work from `file://`
 * with the network off, and a framework would be most of the download for a
 * screen with one list on it.
 */

export type Stage = 'idle' | 'reading' | 'decoding' | 'results';

export interface AppNotice {
	readonly kind: 'error' | 'info';
	readonly text: string;
	/** Extra line for the code, so the message stays plain. */
	readonly detail?: string;
}

export interface AppState {
	readonly stage: Stage;
	readonly accounts: readonly OtpAccount[];
	readonly batch: BatchProgress | null;
	readonly notice: AppNotice | null;
	/** Row indices whose secret is currently shown. */
	readonly revealed: ReadonlySet<number>;
	readonly cameraOn: boolean;
}

export class AppStore {
	private readonly collector = new BatchCollector();
	private listeners: Array<(state: AppState) => void> = [];

	private state: AppState = {
		stage: 'idle',
		accounts: [],
		batch: null,
		notice: null,
		revealed: new Set(),
		cameraOn: false,
	};

	get current(): AppState {
		return this.state;
	}

	subscribe(listener: (state: AppState) => void): () => void {
		this.listeners.push(listener);
		listener(this.state);
		return () => {
			this.listeners = this.listeners.filter((existing) => existing !== listener);
		};
	}

	private set(patch: Partial<AppState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) {
			listener(this.state);
		}
	}

	setStage(stage: Stage): void {
		this.set({ stage, notice: stage === 'idle' ? this.state.notice : null });
	}

	setCamera(on: boolean): void {
		this.set({ cameraOn: on });
	}

	notify(notice: AppNotice | null): void {
		this.set({ notice, stage: this.state.accounts.length > 0 ? 'results' : 'idle' });
	}

	/**
	 * Fold a freshly decoded QR code into the collected export.
	 *
	 * Returns a notice when the scan was refused, so the caller can show it
	 * without having to know the batch rules.
	 */
	ingest(scan: MigrationScan): AppNotice | null {
		const outcome = this.collector.add(scan);

		this.set({
			accounts: this.collector.accounts,
			batch: outcome.progress,
			stage: 'results',
			notice: null,
		});

		switch (outcome.status) {
			case 'added':
				return null;
			case 'duplicate':
				// Not a problem, and worth saying so plainly: with a camera this
				// happens constantly and silence would look like a failure.
				return { kind: 'info', text: 'That part of the export is already captured.' };
			case 'conflict':
				return {
					kind: 'error',
					text: 'That code has the same part number as one already captured, but different contents. It is probably from a different export.',
				};
			case 'foreign-batch':
				return {
					kind: 'error',
					text: 'That code belongs to a different export. Finish this one first, or clear it and start again.',
				};
			case 'size-mismatch':
				return {
					kind: 'error',
					text: 'That code says the export has a different number of parts, so it is probably from a different export.',
				};
		}
	}

	toggleReveal(index: number): void {
		const revealed = new Set(this.state.revealed);
		if (revealed.has(index)) {
			revealed.delete(index);
		} else {
			revealed.add(index);
		}
		this.set({ revealed });
	}

	revealAll(on: boolean): void {
		this.set({
			revealed: on ? new Set(this.state.accounts.map((_, index) => index)) : new Set(),
		});
	}

	/**
	 * Drop everything.
	 *
	 * The secret bytes are overwritten first. Read the comment on `wipe()`
	 * before describing what that achieves: it zeroes these buffers, and it
	 * cannot reach copies the engine made. It is not memory scrubbing, and the
	 * honest claim is that closing the tab is what actually finishes the job.
	 */
	clear(): void {
		for (const account of this.state.accounts) {
			account.secretBytes.fill(0);
		}
		this.collector.reset();
		this.set({
			stage: 'idle',
			accounts: [],
			batch: null,
			notice: null,
			revealed: new Set(),
		});
	}
}

/** Group a code into readable halves, the way authenticators display them. */
export function groupCode(code: string): string {
	const half = Math.ceil(code.length / 2);
	return `${code.slice(0, half)} ${code.slice(half)}`;
}

/** A short, human summary of batch progress, or null for a single-part export. */
export function batchSummary(batch: BatchProgress | null): string | null {
	if (batch === null || batch.size <= 1) {
		return null;
	}
	if (batch.complete) {
		return `All ${batch.size} parts captured.`;
	}
	const missing = batch.missing.map((index) => index + 1).join(', ');
	return `${batch.captured.length} of ${batch.size} parts captured. Still needed: ${missing}.`;
}

import type { MigrationScan, OtpAccount } from '../types.js';
import { accountKey } from './accounts.js';

/**
 * Collecting a multi-part export.
 *
 * Google Authenticator splits a large export across several QR codes. Each one
 * carries the same `batch_id`, the total `batch_size`, and its own
 * `batch_index`, so the parts know they belong together and in what order. This
 * is the part of the job the command line route handles badly: you end up with
 * several unrelated strings and no way to tell whether you have them all.
 *
 * The design decision worth knowing: a re-scan of a part already held is a
 * `duplicate` and is harmless, while the *same index with different bytes* is a
 * `conflict` and is loud. A camera will re-read the same code many times a
 * second, so treating every repeat as an error would make the scanner unusable;
 * but two different exports mixed together would silently produce a set of
 * accounts that never existed, which is much worse than a warning.
 */

export interface BatchProgress {
	readonly batchId: number;
	readonly size: number;
	/** Indices captured so far, ascending. */
	readonly captured: readonly number[];
	readonly missing: readonly number[];
	readonly complete: boolean;
}

export type BatchAddOutcome =
	| { readonly status: 'added'; readonly index: number; readonly progress: BatchProgress }
	| { readonly status: 'duplicate'; readonly index: number; readonly progress: BatchProgress }
	| { readonly status: 'conflict'; readonly index: number; readonly progress: BatchProgress }
	| {
			readonly status: 'foreign-batch';
			readonly seenBatchId: number;
			readonly progress: BatchProgress;
	  }
	| {
			readonly status: 'size-mismatch';
			readonly expected: number;
			readonly seen: number;
			readonly progress: BatchProgress;
	  };

/** A cheap content fingerprint, enough to tell a re-scan from a different part. */
function fingerprint(bytes: Uint8Array): string {
	// FNV-1a. Not cryptographic and does not need to be: the alternative to
	// matching here is showing the user a warning, not trusting a signature.
	let hash = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i += 1) {
		hash ^= bytes[i] as number;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${bytes.length}:${hash.toString(16)}`;
}

interface Part {
	readonly scan: MigrationScan;
	readonly fingerprint: string;
}

export class BatchCollector {
	private batchId: number | null = null;
	private size = 0;
	private readonly parts = new Map<number, Part>();

	add(scan: MigrationScan): BatchAddOutcome {
		const { id, size, index } = scan.batch;

		if (this.batchId === null) {
			this.batchId = id;
			this.size = size;
		} else if (id !== this.batchId) {
			// Not merged. Two exports taken minutes apart can contain
			// overlapping accounts with different secrets, and quietly combining
			// them would produce a list that never existed on the phone.
			return { status: 'foreign-batch', seenBatchId: id, progress: this.progressOrEmpty() };
		} else if (size !== this.size) {
			return {
				status: 'size-mismatch',
				expected: this.size,
				seen: size,
				progress: this.progressOrEmpty(),
			};
		}

		const print = fingerprint(scan.payloadBytes);
		const existing = this.parts.get(index);

		if (existing !== undefined) {
			return {
				status: existing.fingerprint === print ? 'duplicate' : 'conflict',
				index,
				progress: this.progressOrEmpty(),
			};
		}

		this.parts.set(index, { scan, fingerprint: print });
		return { status: 'added', index, progress: this.progressOrEmpty() };
	}

	get progress(): BatchProgress | null {
		return this.batchId === null ? null : this.progressOrEmpty();
	}

	/**
	 * Every account held, in export order, with duplicates removed.
	 *
	 * Ordered by part index and then by position within the part, which is the
	 * order the phone listed them in, so a user checking the results against
	 * their app reads down two lists in step.
	 */
	get accounts(): readonly OtpAccount[] {
		const seen = new Set<string>();
		const out: OtpAccount[] = [];

		for (const index of [...this.parts.keys()].sort((a, b) => a - b)) {
			for (const account of this.parts.get(index)!.scan.accounts) {
				const key = accountKey(account);
				if (!seen.has(key)) {
					seen.add(key);
					out.push(account);
				}
			}
		}

		return out;
	}

	get partCount(): number {
		return this.parts.size;
	}

	reset(): void {
		this.batchId = null;
		this.size = 0;
		this.parts.clear();
	}

	/**
	 * Abandon the current export and start on the one just seen.
	 *
	 * What the user chooses after a `foreign-batch` outcome, when they have
	 * decided the new code is the one they meant.
	 */
	adoptBatch(scan: MigrationScan): BatchAddOutcome {
		this.reset();
		return this.add(scan);
	}

	private progressOrEmpty(): BatchProgress {
		const captured = [...this.parts.keys()].sort((a, b) => a - b);
		const missing: number[] = [];
		for (let i = 0; i < this.size; i += 1) {
			if (!this.parts.has(i)) {
				missing.push(i);
			}
		}

		return {
			batchId: this.batchId ?? 0,
			size: this.size,
			captured,
			missing,
			complete: missing.length === 0 && this.size > 0,
		};
	}
}

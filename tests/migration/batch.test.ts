import { describe, expect, it } from 'vitest';
import { BatchCollector } from '../../src/migration/batch.js';
import { parseMigrationUri } from '../../src/migration/parse-uri.js';
import { unwrap } from '../../src/result.js';
import type { MigrationScan } from '../../src/types.js';
import {
	ALICE,
	BOB,
	CAROL,
	DAVE,
	type PayloadSpec,
	toMigrationUri,
} from '../helpers/build-payload.js';

const scan = (spec: PayloadSpec): MigrationScan => unwrap(parseMigrationUri(toMigrationUri(spec)));

/** A three-part export, as Google produces for a large account list. */
const THREE_PART = {
	one: scan({ accounts: [ALICE], batchSize: 3, batchIndex: 0, batchId: 555 }),
	two: scan({ accounts: [BOB], batchSize: 3, batchIndex: 1, batchId: 555 }),
	three: scan({ accounts: [CAROL], batchSize: 3, batchIndex: 2, batchId: 555 }),
};

describe('BatchCollector with a single-part export', () => {
	it('completes on the first scan', () => {
		const collector = new BatchCollector();
		const outcome = collector.add(scan({ accounts: [ALICE, BOB] }));

		expect(outcome.status).toBe('added');
		expect(outcome.progress.complete).toBe(true);
		expect(outcome.progress.missing).toEqual([]);
		expect(collector.accounts).toHaveLength(2);
	});

	it('reports no progress before anything is added', () => {
		expect(new BatchCollector().progress).toBeNull();
		expect(new BatchCollector().accounts).toEqual([]);
	});
});

describe('BatchCollector with a multi-part export', () => {
	it('merges parts arriving in order', () => {
		const collector = new BatchCollector();

		expect(collector.add(THREE_PART.one).progress.complete).toBe(false);
		expect(collector.add(THREE_PART.two).progress.complete).toBe(false);
		expect(collector.add(THREE_PART.three).progress.complete).toBe(true);
		expect(collector.accounts).toHaveLength(3);
	});

	it('merges parts arriving out of order', () => {
		const collector = new BatchCollector();
		collector.add(THREE_PART.three);
		collector.add(THREE_PART.one);
		const last = collector.add(THREE_PART.two);

		expect(last.progress.complete).toBe(true);
		// Still presented in export order, so the list reads in step with the
		// one on the phone.
		expect(collector.accounts.map((a) => a.accountName)).toEqual([
			'alice@example.com',
			'bob@example.org',
			'A4043',
		]);
	});

	it('says which parts are still missing', () => {
		const collector = new BatchCollector();
		const outcome = collector.add(THREE_PART.two);

		expect(outcome.progress.captured).toEqual([1]);
		expect(outcome.progress.missing).toEqual([0, 2]);
		expect(outcome.progress.size).toBe(3);
		expect(outcome.progress.batchId).toBe(555);
	});
});

describe('BatchCollector rejections', () => {
	it('treats a re-scan of the same part as a harmless duplicate', () => {
		// A camera reads the same code many times a second. Treating each as an
		// error would make the scanner unusable.
		const collector = new BatchCollector();
		collector.add(THREE_PART.one);

		const again = collector.add(THREE_PART.one);
		expect(again.status).toBe('duplicate');
		expect(collector.accounts).toHaveLength(1);
		expect(collector.partCount).toBe(1);
	});

	it('treats the same index with different contents as a conflict', () => {
		const collector = new BatchCollector();
		collector.add(THREE_PART.one);

		const impostor = scan({ accounts: [DAVE], batchSize: 3, batchIndex: 0, batchId: 555 });
		const outcome = collector.add(impostor);

		expect(outcome.status).toBe('conflict');
		// The original is kept; the odd one out is not silently substituted.
		expect(collector.accounts.map((a) => a.accountName)).toEqual(['alice@example.com']);
	});

	it('refuses a part from a different export rather than merging it', () => {
		// Two exports taken minutes apart can hold overlapping accounts with
		// different secrets. Combining them would produce a list of accounts
		// that never existed on the phone.
		const collector = new BatchCollector();
		collector.add(THREE_PART.one);

		const other = scan({ accounts: [DAVE], batchSize: 2, batchIndex: 0, batchId: 999 });
		const outcome = collector.add(other);

		expect(outcome.status).toBe('foreign-batch');
		expect(outcome).toMatchObject({ seenBatchId: 999 });
		expect(collector.accounts).toHaveLength(1);
	});

	it('refuses a part claiming a different total', () => {
		const collector = new BatchCollector();
		collector.add(THREE_PART.one);

		const outcome = collector.add(
			scan({ accounts: [BOB], batchSize: 5, batchIndex: 1, batchId: 555 }),
		);

		expect(outcome.status).toBe('size-mismatch');
		expect(outcome).toMatchObject({ expected: 3, seen: 5 });
	});
});

describe('BatchCollector state changes', () => {
	it('starts over on reset', () => {
		const collector = new BatchCollector();
		collector.add(THREE_PART.one);
		collector.reset();

		expect(collector.progress).toBeNull();
		expect(collector.accounts).toEqual([]);
		// A previously foreign batch is now perfectly acceptable.
		expect(collector.add(scan({ accounts: [DAVE], batchId: 999 })).status).toBe('added');
	});

	it('switches to the new export on adoptBatch', () => {
		const collector = new BatchCollector();
		collector.add(THREE_PART.one);

		const other = scan({ accounts: [DAVE], batchSize: 1, batchIndex: 0, batchId: 999 });
		const outcome = collector.adoptBatch(other);

		expect(outcome.status).toBe('added');
		expect(outcome.progress.batchId).toBe(999);
		expect(outcome.progress.complete).toBe(true);
		expect(collector.accounts.map((a) => a.accountName)).toEqual(['dave@test.invalid']);
	});
});

describe('BatchCollector deduplication', () => {
	it('drops an account that appears in more than one part', () => {
		const collector = new BatchCollector();
		collector.add(scan({ accounts: [ALICE, BOB], batchSize: 2, batchIndex: 0, batchId: 7 }));
		collector.add(scan({ accounts: [BOB, CAROL], batchSize: 2, batchIndex: 1, batchId: 7 }));

		expect(collector.accounts.map((a) => a.accountName)).toEqual([
			'alice@example.com',
			'bob@example.org',
			'A4043',
		]);
	});

	it('keeps two accounts that share an issuer and name but not a secret', () => {
		// Two logins at the same service is a real situation, and collapsing
		// them would lose one of the user's secrets without saying so.
		const first = { ...ALICE };
		const second = { ...ALICE, secret: DAVE.secret };
		const collector = new BatchCollector();
		collector.add(scan({ accounts: [first, second] }));

		expect(collector.accounts).toHaveLength(2);
	});
});

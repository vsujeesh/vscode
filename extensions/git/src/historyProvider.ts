/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, Event, EventEmitter, FileDecoration, FileDecorationProvider, SourceControlHistoryItem, SourceControlHistoryItemChange, SourceControlHistoryItemGroup, SourceControlHistoryOptions, SourceControlHistoryProvider, ThemeIcon, Uri, window, LogOutputChannel } from 'vscode';
import { Repository, Resource } from './repository';
import { IDisposable, filterEvent } from './util';
import { toGitUri } from './uri';
import { Branch, RefType, UpstreamRef } from './api/git';
import { emojify, ensureEmojis } from './emoji';
import { Operation } from './operation';

export class GitHistoryProvider implements SourceControlHistoryProvider, FileDecorationProvider, IDisposable {

	private readonly _onDidChangeCurrentHistoryItemGroup = new EventEmitter<void>();
	readonly onDidChangeCurrentHistoryItemGroup: Event<void> = this._onDidChangeCurrentHistoryItemGroup.event;

	private readonly _onDidChangeDecorations = new EventEmitter<Uri[]>();
	readonly onDidChangeFileDecorations: Event<Uri[]> = this._onDidChangeDecorations.event;

	private _HEAD: Branch | undefined;
	private _currentHistoryItemGroup: SourceControlHistoryItemGroup | undefined;

	get currentHistoryItemGroup(): SourceControlHistoryItemGroup | undefined { return this._currentHistoryItemGroup; }
	set currentHistoryItemGroup(value: SourceControlHistoryItemGroup | undefined) {
		this._currentHistoryItemGroup = value;
		this._onDidChangeCurrentHistoryItemGroup.fire();
	}

	private historyItemDecorations = new Map<string, FileDecoration>();

	private disposables: Disposable[] = [];

	constructor(protected readonly repository: Repository, private readonly logger: LogOutputChannel) {
		this.disposables.push(repository.onDidRunGitStatus(() => this.onDidRunGitStatus(), this));
		this.disposables.push(filterEvent(repository.onDidRunOperation, e => e.operation === Operation.Refresh)(() => this.onDidRunGitStatus(true), this));

		this.disposables.push(window.registerFileDecorationProvider(this));
	}

	private async onDidRunGitStatus(force = false): Promise<void> {
		this.logger.trace('GitHistoryProvider:onDidRunGitStatus - HEAD:', JSON.stringify(this._HEAD));
		this.logger.trace('GitHistoryProvider:onDidRunGitStatus - repository.HEAD:', JSON.stringify(this.repository.HEAD));

		// Check if HEAD has changed
		if (!force &&
			this._HEAD?.name === this.repository.HEAD?.name &&
			this._HEAD?.commit === this.repository.HEAD?.commit &&
			this._HEAD?.upstream?.name === this.repository.HEAD?.upstream?.name &&
			this._HEAD?.upstream?.remote === this.repository.HEAD?.upstream?.remote &&
			this._HEAD?.upstream?.commit === this.repository.HEAD?.upstream?.commit) {
			this.logger.trace('GitHistoryProvider:onDidRunGitStatus - HEAD has not changed');
			return;
		}

		this._HEAD = this.repository.HEAD;

		// Check if HEAD does not support incoming/outgoing (detached commit, tag)
		if (!this._HEAD?.name || !this._HEAD?.commit || this._HEAD.type === RefType.Tag) {
			this.currentHistoryItemGroup = undefined;
			this.logger.trace('GitHistoryProvider:onDidRunGitStatus - HEAD does not support incoming/outgoing');
			return;
		}

		this.currentHistoryItemGroup = {
			id: `refs/heads/${this._HEAD.name ?? ''}`,
			label: this._HEAD.name ?? '',
			base: this._HEAD.upstream ?
				{
					id: `refs/remotes/${this._HEAD.upstream.remote}/${this._HEAD.upstream.name}`,
					label: `${this._HEAD.upstream.remote}/${this._HEAD.upstream.name}`,
				} : undefined
		};

		this.logger.trace('GitHistoryProvider:onDidRunGitStatus - currentHistoryItemGroup:', JSON.stringify(this.currentHistoryItemGroup));
	}

	async provideHistoryItems(historyItemGroupId: string, options: SourceControlHistoryOptions): Promise<SourceControlHistoryItem[]> {
		//TODO@lszomoru - support limit and cursor
		if (typeof options.limit === 'number') {
			throw new Error('Unsupported options.');
		}
		if (typeof options.limit?.id !== 'string') {
			throw new Error('Unsupported options.');
		}

		const refParentId = options.limit.id;
		const refId = await this.repository.revParse(historyItemGroupId) ?? '';

		const historyItems: SourceControlHistoryItem[] = [];
		const commits = await this.repository.log({ range: `${refParentId}..${refId}`, shortStats: true, sortByAuthorDate: true });

		await ensureEmojis();

		historyItems.push(...commits.map(commit => {
			const newLineIndex = commit.message.indexOf('\n');
			const subject = newLineIndex !== -1 ? commit.message.substring(0, newLineIndex) : commit.message;

			return {
				id: commit.hash,
				parentIds: commit.parents,
				label: emojify(subject),
				description: commit.authorName,
				icon: new ThemeIcon('git-commit'),
				timestamp: commit.authorDate?.getTime(),
				statistics: commit.shortStat ?? { files: 0, insertions: 0, deletions: 0 },
			};
		}));

		return historyItems;
	}

	async provideHistoryItemSummary(historyItemId: string, historyItemParentId: string | undefined): Promise<SourceControlHistoryItem> {
		if (!historyItemParentId) {
			const commit = await this.repository.getCommit(historyItemId);
			historyItemParentId = commit.parents.length > 0 ? commit.parents[0] : `${historyItemId}^`;
		}

		const allChanges = await this.repository.diffBetweenShortStat(historyItemParentId, historyItemId);
		return { id: historyItemId, parentIds: [historyItemParentId], label: '', statistics: allChanges };
	}

	async provideHistoryItemChanges(historyItemId: string, historyItemParentId: string | undefined): Promise<SourceControlHistoryItemChange[]> {
		if (!historyItemParentId) {
			const commit = await this.repository.getCommit(historyItemId);
			historyItemParentId = commit.parents.length > 0 ? commit.parents[0] : `${historyItemId}^`;
		}

		const historyItemChangesUri: Uri[] = [];
		const historyItemChanges: SourceControlHistoryItemChange[] = [];
		const changes = await this.repository.diffBetween(historyItemParentId, historyItemId);

		for (const change of changes) {
			const historyItemUri = change.uri.with({
				query: `ref=${historyItemId}`
			});

			// History item change
			historyItemChanges.push({
				uri: historyItemUri,
				originalUri: toGitUri(change.originalUri, historyItemParentId),
				modifiedUri: toGitUri(change.uri, historyItemId),
				renameUri: change.renameUri,
			});

			// History item change decoration
			const letter = Resource.getStatusLetter(change.status);
			const tooltip = Resource.getStatusText(change.status);
			const color = Resource.getStatusColor(change.status);
			const fileDecoration = new FileDecoration(letter, tooltip, color);
			this.historyItemDecorations.set(historyItemUri.toString(), fileDecoration);

			historyItemChangesUri.push(historyItemUri);
		}

		this._onDidChangeDecorations.fire(historyItemChangesUri);
		return historyItemChanges;
	}

	async resolveHistoryItemGroupCommonAncestor(historyItemId1: string, historyItemId2: string | undefined): Promise<{ id: string; ahead: number; behind: number } | undefined> {
		if (!historyItemId2) {
			const upstreamRef = await this.resolveHistoryItemGroupBase(historyItemId1);
			if (!upstreamRef) {
				return undefined;
			}

			historyItemId2 = `refs/remotes/${upstreamRef.remote}/${upstreamRef.name}`;
		}

		const ancestor = await this.repository.getMergeBase(historyItemId1, historyItemId2);
		if (!ancestor) {
			return undefined;
		}

		try {
			const commitCount = await this.repository.getCommitCount(`${historyItemId1}...${historyItemId2}`);
			return { id: ancestor, ahead: commitCount.ahead, behind: commitCount.behind };
		} catch (err) {
			this.logger.error(`Failed to get ahead/behind for '${historyItemId1}...${historyItemId2}': ${err.message}`);
		}

		return undefined;
	}

	provideFileDecoration(uri: Uri): FileDecoration | undefined {
		return this.historyItemDecorations.get(uri.toString());
	}

	private async resolveHistoryItemGroupBase(historyItemId: string): Promise<UpstreamRef | undefined> {
		try {
			// Upstream
			const branch = await this.repository.getBranch(historyItemId);
			if (branch.upstream) {
				return branch.upstream;
			}

			// Base (config -> reflog -> default)
			const remoteBranch = await this.repository.getBranchBase(historyItemId);
			if (!remoteBranch?.remote || !remoteBranch?.name || !remoteBranch?.commit || remoteBranch?.type !== RefType.RemoteHead) {
				return undefined;
			}

			return {
				name: remoteBranch.name,
				remote: remoteBranch.remote,
				commit: remoteBranch.commit
			};
		}
		catch (err) {
			this.logger.error(`Failed to get branch base for '${historyItemId}': ${err.message}`);
		}

		return undefined;
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

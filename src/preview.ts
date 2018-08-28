'use strict';

import * as fs from 'fs';
import * as events from 'events';
import * as path from 'path';
import * as vscode from 'vscode';
import * as rx from 'rx-lite';
import * as review from 'review.js';
import * as reviewprh from 'reviewjs-prh';

const review_scheme = "review";

class ReviewTextDocumentContentProvider implements vscode.TextDocumentContentProvider, vscode.DocumentSymbolProvider, vscode.Disposable {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri> ();
	private _emitter = new events.EventEmitter ();
	private _subscription = rx.Observable.fromEvent<vscode.TextDocumentChangeEvent> (this._emitter, "data")
		.sample (rx.Observable.interval (1000))
		.subscribe (event => {
			if (event.document === vscode.window.activeTextEditor.document) {
				this.update (getSpecialSchemeUri (event.document.uri));
			}
		});

	public constructor () {
		vscode.workspace.onDidChangeTextDocument ((event: vscode.TextDocumentChangeEvent) => {
			this._emitter.emit ("data", event)
		});
	}

	public provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.SymbolInformation[] | Thenable<vscode.DocumentSymbol[]> {
		return processDocument (document).then (book => document_symbols);
	}

	public provideTextDocumentContent (uri: vscode.Uri): string | Thenable<string> {
		return new Promise<string> ((resolve, reject) => {
			vscode.workspace.openTextDocument (vscode.Uri.parse (uri.query))
			.then (doc => resolve (this.convert (doc)),
			reason => reject (reason))
		});
	}

	get onDidChange(): vscode.Event<vscode.Uri> {
		return this._onDidChange.event;
	}

	public dispose () {
		this._subscription.unsubscribe ();
	}

	public update (uri: vscode.Uri) {
		this._onDidChange.fire (uri);
	}

	private convert (document: vscode.TextDocument): Promise<string> {
		return new Promise<string> ((resolve, rejected) => {
			processDocument (document).then (
				buffer => {
					var result = "";
					buffer.allChunks.forEach (chunk => chunk.builderProcesses.forEach (proc => result += proc.result));
					if (!result.startsWith ("<html") && !result.startsWith ("<!DOCTYPE"))
						result = "<html><head><base href=\"" + document.fileName + "\" /><style type='text/css'>body { color: black; background-color: white }</style></head><body>" + result + "</body></html>";
					return resolve (result);
				},
				reason => rejected (reason)
			);
		});
	}
}

function reportLevelToSeverity (level: review.ReportLevel): vscode.DiagnosticSeverity {
	switch (level) {
		case review.ReportLevel.Error: return vscode.DiagnosticSeverity.Error;
		case review.ReportLevel.Info: return vscode.DiagnosticSeverity.Information;
		case review.ReportLevel.Warning: return vscode.DiagnosticSeverity.Warning;
	}
	return vscode.DiagnosticSeverity.Information;
}

function locationToRange (loc: review.Location): vscode.Range {
	return new vscode.Range (
		new vscode.Position (loc.start.line - 1, loc.start.column - 1),
		new vscode.Position (loc.end.line - 1, loc.end.column - 1));
}

function showPreview (uri: vscode.Uri) {
	if (!(uri instanceof vscode.Uri)) {
		if (vscode.window.activeTextEditor) {
			uri = vscode.window.activeTextEditor.document.uri;
		}
	}
	return vscode.commands.executeCommand ('vscode.previewHtml', getSpecialSchemeUri (uri), vscode.ViewColumn.Two);
}

var document_symbols: vscode.DocumentSymbol[] = Array.of<vscode.DocumentSymbol> ();
var last_diagnostics: vscode.DiagnosticCollection = null;

interface ReviewSymbol {
	readonly level: number;
	readonly parent: ReviewSymbol | undefined;
	readonly children: vscode.DocumentSymbol[]
}

function processDocument (document: vscode.TextDocument): Promise<review.Book> {
	var getEOLPosition = (line: number): vscode.Position => document.lineAt (line).range.end;

	function getPositionJustBefore (pos: vscode.Position): vscode.Position {
		if (pos.line === 0 && pos.character === 0) {
			return new vscode.Position (0, 0);
		}
		return pos.character === 0 ? getEOLPosition (pos.line - 1) : new vscode.Position (pos.line, pos.character - 1);
	}

	return review.start (controller => {
		var prhFile = path.join (path.dirname (document.fileName), "prh.yml");
		var validators: review.Validator[];
		try {
			validators = [new review.DefaultValidator(), new reviewprh.TextValidator(prhFile)];
		} catch (any) {
			validators = [new review.DefaultValidator()];
		}
		controller.initConfig ({
			basePath: path.dirname (document.fileName),
			validators: validators,
			read: path => Promise.resolve(document.getText()),
			write: (path, data) => Promise.resolve(void {}),
			listener: {
				// onAcceptables: ... ,
				onSymbols: function (symbols) {
					function organizeSymbols (parent: ReviewSymbol, symbols: review.Symbol[]) {
						if (!symbols.length) {
							return;
						}

						let symbol = symbols[0];
						// Uses `detail` to distinguish columns from headlines.
						// It's a bit dirty hack but it's needed to avoid 2-pass scan.
						// Uutilizing vscode.SymbolKind is an alternative but cannot fill a concept gap anyway.
						let docSymbol = new vscode.DocumentSymbol (
							getLabelName (symbol), getLabelDetail (symbol), vscode.SymbolKind.Null, locationToRange (symbol.node.location), locationToRange (symbol.node.location));
						let level = extractLevel (symbol);
						if (docSymbol === undefined || level === -Infinity) {
							return;
						}
						docSymbol.children = [];
						while (parent && level <= parent.level) {
							parent = parent.parent!;
							// Adjust end marker on level change
							if (parent.children.length !== 0) {
								let lastChild = parent.children[parent.children.length - 1];
								// columns themselves have correct end markers so DON'T perform adjustment
								if (lastChild.detail !== 'column') {
									lastChild.range = new vscode.Range (lastChild.range.start, getPositionJustBefore (docSymbol.range.start));
								}
							}
						}
						parent.children.push (docSymbol);
						organizeSymbols ({level, children: docSymbol.children, parent}, symbols.slice (1));
						if (symbols.length === 1) {
							// symbols exhausted. i.e. document ended. Put `end` markers for all "opened" DocumentSymbols for building Breadcrumbs.
							var p = parent;
							while (p.parent !== undefined) {
								let lastElem = p.parent!.children[p.parent!.children.length - 1];
								lastElem.range = new vscode.Range (lastElem.range.start, docSymbol.range.end);
								p = p.parent;
							}
						}
					}

					function extractLevel (src: review.Symbol): number {
						switch (src.node.ruleName) {
							case review.RuleName.Headline:
								return src.node.toHeadline ().level;
							case review.RuleName.Column:
								return src.node.toColumn ().level;
							default:
								return -Infinity;
						}
					}

					function getLabelName (src: review.Symbol): string {
						switch (src.node.ruleName) {
							case review.RuleName.Headline:
								return src.labelName;
							case review.RuleName.Column:
								return "[column] " + src.node.toColumn ().headline.caption.childNodes[0].toTextNode ().text;
							default:
								return undefined;
						}
					}

					function getLabelDetail (src: review.Symbol): string {
						switch (src.node.ruleName) {
							case review.RuleName.Headline:
								return "headline";
							case review.RuleName.Column:
								return "column";
							default:
								return undefined;
						}
					}
					const root: ReviewSymbol = {
						level: -Infinity,
						children: [],
						parent: undefined
					};
					organizeSymbols (root, symbols.filter (o => !o.node.isInlineElement() && (o.symbolName === "hd" || o.symbolName === "column")));
					document_symbols = root.children;
				},
				onReports: function (reports) {
					var dc = Array.of<vscode.Diagnostic> ();
					for (var i = 0; i < reports.length; i++) {
						var loc = reports [i].nodes.length > 0 ? reports [i].nodes [0].location : null;
						dc.push (new vscode.Diagnostic (locationToRange (loc), reports [i].message, reportLevelToSeverity (reports [i].level)));
					}
					if (last_diagnostics != null)
						last_diagnostics.dispose ();
					last_diagnostics = vscode.languages.createDiagnosticCollection ("Re:VIEW validation");
					last_diagnostics.set (document.uri, dc);
				},
			},
			builders: [ new review.HtmlBuilder (false) ],
			book: { contents: [{file: path.basename (document.fileName)}] }
		});
	});
}

function maybeProcessDocument (document: vscode.TextDocument) {
	if (document.uri.scheme == review_scheme)
		processDocument (document);
}

function getSpecialSchemeUri (uri: any): vscode.Uri {
	return uri.with({
		scheme: review_scheme,
		path: uri.path,
		query: uri.toString ()
	});
}

export function activate (context : vscode.ExtensionContext) {
	let provider = new ReviewTextDocumentContentProvider ();
	let registration = vscode.workspace.registerTextDocumentContentProvider (review_scheme, provider);
	vscode.languages.registerDocumentSymbolProvider (review_scheme, provider);
	vscode.workspace.onDidOpenTextDocument (maybeProcessDocument);
	vscode.workspace.onDidSaveTextDocument (maybeProcessDocument);
	let d1 = vscode.commands.registerCommand ("review.showPreview", uri => showPreview (uri), vscode.ViewColumn.Two);
	let d2 = vscode.commands.registerCommand ("review.checkSyntax", uri => maybeProcessDocument (vscode.window.activeTextEditor.document));
	context.subscriptions.push (d1, d2, registration, provider);
}

export function deactivate () {
}

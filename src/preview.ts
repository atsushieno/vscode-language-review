'use strict';

import * as fs from 'fs';
import * as events from 'events';
import * as path from 'path';
import * as vscode from 'vscode';
import * as rx from 'rx-lite';
import * as review from 'review.js';
import { clearTimeout } from 'timers';

const review_scheme = "review";

class ReviewSymbolProvider implements vscode.DocumentSymbolProvider, vscode.Disposable {

	public constructor () {}

	public provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.SymbolInformation[] | Thenable<vscode.DocumentSymbol[]>
	{
		// FIXME: uncomment this and get it working
		// (it does not, because it is most likely invoked way before processDocument() completes and updates the symbols).
		// This should not trigger processDocument every time vscode requests symbols (it invokes this method for every change)
		//if (document_symbols == null)
			return processDocument (document).then (_ => document_symbols, _ => document_symbols);
		//else
		//	Promise.resolve (document_symbols);
	}

	public dispose ()
	{
	}
}

function convert_review_doc_to_html (document: vscode.TextDocument, getAssetUri: (...relPath: string[]) => vscode.Uri): Promise<string> {
	return new Promise<string> ((resolve, rejected) => {
		processDocument (document).then (
			buffer => {
				var result = "";
				buffer.allChunks.forEach (chunk => chunk.builderProcesses.forEach (proc => result += proc.result));
				if (!result.startsWith ("<html") && !result.startsWith ("<!DOCTYPE"))
					result = "<html><head><base href=\"" + document.fileName + "\" />" + getStyleTag() + "</head><body>" + result + "</body></html>";
				return resolve (result);
			},
			reason => rejected (reason)
		);

		var getStyleTag = (): string => `<link rel="stylesheet" type="text/css" href="${getAssetUri('media', 'style.css')}">`;
	});
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

var document_symbols: vscode.DocumentSymbol[] = null;
var last_diagnostics: vscode.DiagnosticCollection = null;

interface ReviewSymbol {
	readonly level: number;
	readonly parent: ReviewSymbol | undefined;
	readonly children: vscode.DocumentSymbol[]
}

function maybeProcessDocument (document: vscode.TextDocument): Promise<review.Book> {
	if (document.uri.scheme != review_scheme)
		return;
	return processDocument (document);
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
		validators = [new review.DefaultValidator()];
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
						if (docSymbol.detail === 'column') {
							// Adjust column ending position because review.js returns the one overlaps with the next element.
							docSymbol.range = new vscode.Range (docSymbol.range.start, getPositionJustBefore (docSymbol.range.end));
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
							let endOfDocumentPos = getEOLPosition (document.lineCount - 1);
							// First, adjust range of the last symbol because non-column symbols don't have correct ending positions yet.
							if (getLabelDetail (symbol) !== 'column') {
								docSymbol.range = new vscode.Range (docSymbol.range.start, endOfDocumentPos);
							}
							// Then, propagate ending position to ancestors.
							var p = parent;
							while (p.parent !== undefined) {
								let lastElem = p.parent!.children[p.parent!.children.length - 1];
								lastElem.range = new vscode.Range (lastElem.range.start, endOfDocumentPos);
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
								const caption = src.node.toHeadline().caption.childNodes[0].toTextNode().text;
								return caption === src.labelName ? src.labelName : `{${src.labelName}} ${caption}`;
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

var previews = new Map<string,vscode.WebviewPanel> ();

function startPreview (uri: vscode.Uri, context: vscode.ExtensionContext) {
	if (!(uri instanceof vscode.Uri)) {
		if (vscode.window.activeTextEditor) {
			uri = vscode.window.activeTextEditor.document.uri;
		}
	}

	var webView = vscode.window.createWebviewPanel ('vscode-language-review', "[preview]" + path.basename(uri.path), vscode.ViewColumn.Two);
	previews.set(uri.fsPath, webView);
	var doc = vscode.workspace.textDocuments.find((d,_,__) => d.uri.fsPath == uri.fsPath);
	var getAssetUri = (...relPath: string[]) =>
	    vscode.Uri.file (path.join (context.extensionPath, ...relPath)).with ({ scheme: 'vscode-resource' });
	convert_review_doc_to_html(doc, getAssetUri).then (
		successResult => webView.webview.html = successResult,
		failureReason => webView.webview.html = failureReason);

	var last_changed_event: vscode.TextDocumentChangeEvent = null;
	var timer = setInterval(() => maybeUpdatePreview (last_changed_event, getAssetUri), 1000);
	vscode.workspace.onDidChangeTextDocument (e => last_changed_event = e);

	webView.onDidDispose(()=> {
		clearInterval (timer);
		this._webViewPanel = null;
	});
}

function maybeUpdatePreview (e: vscode.TextDocumentChangeEvent, f: (...path: string[]) => vscode.Uri) {
	if (e == null || e.document.uri == null)
		return;
	var webView = previews.get(e.document.uri.fsPath);
	if (webView == null)
		return;
	convert_review_doc_to_html (e.document, f).then (
		successResult => webView.webview.html = successResult,
		failureReason => webView.webview.html = failureReason);
}

export function activate (context : vscode.ExtensionContext) {
	let provider = new ReviewSymbolProvider ();
	vscode.languages.registerDocumentSymbolProvider (review_scheme, provider);

	vscode.workspace.onDidOpenTextDocument (maybeProcessDocument);
	vscode.workspace.onDidSaveTextDocument (maybeProcessDocument);
	let d1 = vscode.commands.registerCommand ("review.showPreview", uri => startPreview (uri, context));
	let d2 = vscode.commands.registerCommand ("review.checkSyntax", uri => processDocument (vscode.window.activeTextEditor.document));
	context.subscriptions.push (d1, d2, provider);
}

export function deactivate () {
}

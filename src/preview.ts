'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import * as review from 'review.js';

const review_scheme = "review";

class ReviewTextDocumentContentProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri> ();

	public provideTextDocumentContent (uri: vscode.Uri): string | Thenable<string> {
		return vscode.workspace.openTextDocument (vscode.Uri.parse (uri.query)).then (doc => {
			return this.convert (doc);
		});
	}

	get onDidChange(): vscode.Event<vscode.Uri> {
		return this._onDidChange.event;
	}

	public update (uri: vscode.Uri) {
		this._onDidChange.fire (uri);
	}

	private convert (document: vscode.TextDocument): string | Promise<string> {
		let promise = new Promise ((resolve, rejected) => {
			let src = document.getText ();
			var files = {};
			var results = {};
			files [path.basename (document.fileName)] = src;
			review.start (controller => {
				controller.initConfig ({
					basePath: path.dirname (document.fileName),
					read: path => Promise.resolve (files [path]),
					//write: (path, content) => { results [path] = content; return Promise.resolve (null) }, 

					listener: {
						// onAcceptables: ... ,
						onReports: function (reports) {
							for (var i = 0; i < reports.length; i++) {
								switch (reports [i].level) {
								case review.ReportLevel.Error:
									vscode.window.showErrorMessage (reports [i].message);
									break;
								case review.ReportLevel.Warning:
									vscode.window.showWarningMessage (reports [i].message);
									break;
								case review.ReportLevel.Info:
									vscode.window.showInformationMessage (reports [i].message);
									break;
								}
							}
						},

						onCompileSuccess: function (book) {
							vscode.window.showInformationMessage ("compilation successful.");
						},
						onCompileFailed: function () {
							vscode.window.showInformationMessage ("compilation failure.");
						}
					},
					builders: [ new review.HtmlBuilder (false) ],
					book: { contents: [ path.basename (document.fileName) ] }
				});
			}).then (
				buffer => {
					var result = "";
					buffer.allChunks.forEach (chunk => chunk.builderProcesses.forEach (proc => result += proc.result));
					if (!result.startsWith ("<html") && !result.startsWith ("<!DOCTYPE"))
						result = "<html><head><base href=\"" + document.fileName + "\" /></head><body>" + result + "</body></html>";
					return resolve (result);
				},
				reason => rejected (reason)
			);
		});
		return promise;
	}
}

function showPreview (uri: vscode.Uri) {
	if (!(uri instanceof vscode.Uri)) {
		if (vscode.window.activeTextEditor) {
			uri = vscode.window.activeTextEditor.document.uri;
		}
	}
	return vscode.commands.executeCommand ('vscode.previewHtml', getSpecialSchemeUri (uri), vscode.ViewColumn.Two);
}

export function activate (context : vscode.ExtensionContext) {
    let provider = new ReviewTextDocumentContentProvider ();
    vscode.workspace.onDidChangeTextDocument ((event: vscode.TextDocumentChangeEvent) => {
        if (event.document === vscode.window.activeTextEditor.document) {
            provider.update (getSpecialSchemeUri (event.document.uri));
        }
    });
    let registration = vscode.workspace.registerTextDocumentContentProvider (review_scheme, provider);
    let d1 = vscode.commands.registerCommand ("review.showPreview", uri => showPreview (uri), vscode.ViewColumn.Two);
    context.subscriptions.push (d1, registration);
}

function getSpecialSchemeUri (uri: any): vscode.Uri {
	return uri.with({
		scheme: review_scheme,
		path: uri.path,
		query: uri.toString ()
	});
}

export function deactivate () {
}

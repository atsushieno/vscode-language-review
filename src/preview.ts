'use strict';

import * as vscode from 'vscode';
import * as review from 'review.js';

const review_scheme = "review";

class ReviewTextDocumentContentProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri> ();

	public provideTextDocumentContent (uri: vscode.Uri): string | Thenable<string> {
		return vscode.workspace.openTextDocument (vscode.Uri.parse (uri.query)).then (doc => {
			return this.render (doc);
		});
	}

	get onDidChange(): vscode.Event<vscode.Uri> {
		return this._onDidChange.event;
	}

	public update (uri: vscode.Uri) {
		this._onDidChange.fire (uri);
	}

	private render (document: vscode.TextDocument): string | Promise<string> {
		let promise = new Promise ((resolve, rejected) => {
			let src = document.getText ();
			var files = { "whee.re": src };
			var results = {};
			review.start (controller => {
				controller.initConfig ({
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
					book: { contents: [ "whee.re" ] }
				});
			}).then (
				buffer => {
					var result = "";
					buffer.allChunks.forEach (chunk => chunk.builderProcesses.forEach (proc => result += proc.result));
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
	return vscode.commands.executeCommand ('vscode.previewHtml', getRenderedUri (uri), vscode.ViewColumn.Two);
}

export function activate (context : vscode.ExtensionContext) {
    let provider = new ReviewTextDocumentContentProvider ();
    vscode.workspace.onDidChangeTextDocument ((event: vscode.TextDocumentChangeEvent) => {
        if (event.document === vscode.window.activeTextEditor.document) {
            provider.update (getRenderedUri (event.document.uri));
        }
    });
    let registration = vscode.workspace.registerTextDocumentContentProvider (review_scheme, provider);
    let d1 = vscode.commands.registerCommand ("review.showPreview", uri => showPreview (uri), vscode.ViewColumn.Two);
    context.subscriptions.push (d1, registration);
}

function getRenderedUri (uri: any): vscode.Uri {
	return uri.with({
		scheme: review_scheme,
		path: uri.path,
		query: uri.toString ()
	});
}

export function deactivate () {
}

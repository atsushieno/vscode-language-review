'use strict';

import * as vscode from 'vscode';
import * as preview from './preview';


export function activate (context : vscode.ExtensionContext) {
	preview.activate (context);
}


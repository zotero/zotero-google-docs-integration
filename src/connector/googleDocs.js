/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2022 Corporation for Digital Scholarship
                     Vienna, Virginia, USA
					http://zotero.org
	
	This file is part of Zotero.
	
	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	
	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
	
	***** END LICENSE BLOCK *****
*/
(function() {

var isTopWindow = false;
if(window.top) {
	try {
		isTopWindow = window.top == window;
	} catch(e) {};
}
if (!isTopWindow) return;

Zotero.GoogleDocs = {
	config: {
		noteInsertionPlaceholderURL: 'https://www.zotero.org/?',
		fieldURL: 'https://www.zotero.org/google-docs/?',
		brokenFieldURL: 'https://www.zotero.org/google-docs/?broken=',
		fieldKeyLength: 6,
		citationPlaceholder: "{Updating}",
		fieldPrefix: "Z_F",
		dataPrefix: "Z_D",
		biblStylePrefix: "Z_B",
		twipsToPoints: 0.05,
	},
	clients: {},

	// Set to true if there are links in the doc with zotero field url. Causes the
	// download intercept warning to show telling users to unlink citations first before download
	hasZoteroCitations: false,
	// Prevent the download interception warning
	downloadInterceptBlocked: false,
	// Prevents the download intercept dialog from showing once if the user confirms they
	// want to download the document anyway
	downloadIntercepted: false,

	name: "Zotero Google Docs Plugin",
	updateBatchSize: 32,

	init: async function() {
		if (!await Zotero.Prefs.getAsync('integration.googleDocs.enabled')) return;
		
		await this.initClient();
		
		await Zotero.Inject.loadReactComponents();
		if (Zotero.isBrowserExt) {
			await Zotero.Connector_Browser.injectScripts(['zotero-google-docs-integration/ui.js']);
		}
		Zotero.GoogleDocs.UI.init();
		window.addEventListener(`${Zotero.GoogleDocs.name}.call`, async function(e) {
			var client = Zotero.GoogleDocs.clients[e.data.client.id];
			if (!client) {
				client = new Zotero.GoogleDocs.Client();
				await client.init();
			}
			client.call.apply(client, e.data.args);
		});
		
		// Start monitoring for tab changes
		this.monitorTabChanges();
	},

	initClient: async function(reinit=false) {
		if (reinit) {
			delete this.lastClient;
		}
		// Check if we should use ClientAppsScript based on reportTranslationFailure preference
		// and server-side configuration
		let useV2API = await Zotero.Prefs.getAsync('integration.googleDocs.useV2API');
		if (await Zotero.Prefs.getAsync('reportTranslationFailure')) {
			try {
				let xhr = await Zotero.HTTP.request('GET', ZOTERO_CONFIG.SETTINGS_URL, { headers: { "Zotero-Connector-Version": Zotero.version }});
				let response = JSON.parse(xhr.responseText);
				useV2API = response.gdocs_version === 2;
			} catch (e) {
				Zotero.debug('Failed to check repo if isGoogleDocsV2Enabled: ' + e.message);
			}
		}
		
		Zotero.debug(useV2API ? 'Using V2 API' : 'Using ClientAppsScript');
		if (!useV2API) {
			Zotero.GoogleDocs.Client = Zotero.GoogleDocs.ClientAppsScript;
			delete Zotero.GoogleDocs.lastClient;
		}
	},

	execCommand: async (command, client, showOrphanedCitationAlert=true) => {
		if (Zotero.GoogleDocs.UI.isDocx) {
			return Zotero.GoogleDocs.UI.displayDocxAlert();
		}
		if (!client) {
			client = new Zotero.GoogleDocs.Client();
			await client.init();
			const shouldContinue = await Zotero.GoogleDocs.UI.warnIfLargeDoc(client.documentID);
			if (!shouldContinue) {
				Zotero.debug('User cancelled the request in the large document warning');
				return;
			}
		}

		if (command == 'addEditCitation') {
			const shouldContinue = await Zotero.GoogleDocs.UI.alertIfCursorInBrokenCitation();
			if (!shouldContinue) return;
		}

		window.dispatchEvent(new MessageEvent('Zotero.Integration.execCommand', {
			data: {client: {documentID: client.documentID, name: Zotero.GoogleDocs.name, id: client.id}, command}
		}));
		this.lastClient = client;
	},

	respond: function(client, response) {
		window.dispatchEvent(new MessageEvent('Zotero.Integration.respond', {
			data: {client: {documentID: client.documentID, name: Zotero.GoogleDocs.name, id: client.id}, response}
		}));
	},

	editField: async function() {
		// Use the last client with a cached field list to speed up the cursorInField() lookup
		var client = this.lastClient || new Zotero.GoogleDocs.Client();
		await client.init();
		let shouldContinue = await Zotero.GoogleDocs.UI.warnIfLargeDoc(client.documentID);
		if (!shouldContinue) {
			Zotero.debug('User cancelled the request in the large document warning');
			return;
		}

		try {
			var field = await client.cursorInField();
		} catch (e) {
			if (client.isV2 && e.message.startsWith('500: Google Docs request failed')) {
				Zotero.debug(`500 error in editField(). Switching to Apps Script`);
				Zotero.logError(e);
				// Switch over to ClientAppsScript if 500 error here.
				this.lastClient = new Zotero.GoogleDocs.ClientAppsScript();
				await client.init();
				return Zotero.GoogleDocs.editField();
			}
			Zotero.debug(`Exception in editField()`);
			Zotero.logError(e);
			return client.displayAlert(e.message, 0, 0);
		}
		// Remove lastClient fields to ensure execCommand calls receive fresh fields
		if (this.lastClient) {
			this.lastClient.reset();
		}
		
		if (field && field.code.indexOf("BIBL") == 0) {
			return Zotero.GoogleDocs.execCommand("addEditBibliography", client);
		} else {
			return Zotero.GoogleDocs.execCommand("addEditCitation", client, false);
		}
	},
	
	monitorTabChanges: function() {
		// Store the current tab ID
		this.currentTabId = this.getTabId();
		
		// Check for tab changes when location changes
		const checkTabChange = () => {
			const newTabId = this.getTabId();
			if (this.currentTabId !== newTabId) {
				Zotero.debug(`Google Docs tab changed from ${this.currentTabId} to ${newTabId}`);
				this.currentTabId = newTabId;
				
				// Reset the last client when tab changes
				if (this.lastClient) {
					this.lastClient.reset();
				}
			}
		};
		
		// Override history methods to catch programmatic navigation
		(() => {
			let oldPushState = history.pushState;
			history.pushState = function pushState() {
				let ret = oldPushState.apply(this, arguments);
				window.dispatchEvent(new Event('locationchange'));
				return ret;
			};

			let oldReplaceState = history.replaceState;
			history.replaceState = function replaceState() {
				let ret = oldReplaceState.apply(this, arguments);
				window.dispatchEvent(new Event('locationchange'));
				return ret;
			};

			window.addEventListener('popstate', () => {
				window.dispatchEvent(new Event('locationchange'));
			});
		})();
		
		// Listen for our custom locationchange event
		window.addEventListener('locationchange', checkTabChange);
	},
	
	getTabId: function () {
		return new URL(document.location.href).searchParams.get('tab') || "";
	}
};
	
// Don't autoinit on test pages
const isTestPage = Zotero.isBrowserExt && window.location.href.startsWith(browser.runtime.getURL('test'));
if (isTestPage) return;

if (document.readyState !== "complete") {
	window.addEventListener("load", function(e) {
		if (e.target !== document) return;
		Zotero.GoogleDocs.init();
	}, false);
} else {
	Zotero.GoogleDocs.init();
}

})();

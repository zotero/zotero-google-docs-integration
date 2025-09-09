/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2017 Center for History and New Media
					George Mason University, Fairfax, Virginia, USA
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

const TABS_CRITERIA_METHODS = new Set(['replaceNamedRangeContent', 'replaceAllText', 'deleteNamedRange'])
const TAB_ID_METHODS = new Set(['deletePositionedObject', 'replaceImage', 'updateDocumentStyle', 'deleteHeader', 'deleteFooter', 'location', 'range'])
const TAB_ID_PARAMS = new Set(['location', 'range'])

Zotero.GoogleDocs = Zotero.GoogleDocs || {};

Zotero.GoogleDocs.API = {
	authDeferred: null,
	authCredentials: {},
	apiVersion: 6,
	V2BrokenDocsById: {},
	
	init: async function() {
		this.authCredentials = await Zotero.Utilities.Connector.createMV3PersistentObject('googleDocsAuthCredentials')
	},
	
	resetAuth: function() {
		delete this.authCredentials.headers;
		delete this.authCredentials.lastEmail;
	},

	getAuthHeaders: async function() {
		// Delete headers if expired which will cause a refetch
		if (Zotero.GoogleDocs.API.authCredentials.expiresAt && Date.now() > Zotero.GoogleDocs.API.authCredentials.expiresAt) {
			delete Zotero.GoogleDocs.API.authCredentials.headers;
		}
		if (Zotero.GoogleDocs.API.authCredentials.headers) {
			return Zotero.GoogleDocs.API.authCredentials.headers;
		}
		
		// For macOS, since popping up an auth window or calling Connector_Browser.bringToFront()
		// doesn't move the progress window to the back
		Zotero.Connector.callMethod('sendToBack');
		
		// Request OAuth2 access token
		let params = {
			client_id: ZOTERO_CONFIG.OAUTH.GOOGLE_DOCS.CLIENT_KEY,
			redirect_uri: ZOTERO_CONFIG.OAUTH.GOOGLE_DOCS.CALLBACK_URL,
			response_type: 'token',
			scope: 'https://www.googleapis.com/auth/documents email',
			// Will be enabled by Google on June 17, 2024. Uncomment for testing
			// enable_granular_consent: "true",
			state: 'google-docs-auth-callback'
		};
		if (Zotero.GoogleDocs.API.authCredentials.lastEmail) {
			params.login_hint = Zotero.GoogleDocs.API.authCredentials.lastEmail;
		}
		let url = ZOTERO_CONFIG.OAUTH.GOOGLE_DOCS.AUTHORIZE_URL + "?";
		for (let key in params) {
			url += `${key}=${encodeURIComponent(params[key])}&`;
		}
		Zotero.Connector_Browser.openWindow(url, {type: 'normal', onClose: Zotero.GoogleDocs.API.onAuthCancel});
		this.authDeferred = Zotero.Promise.defer();
		return this.authDeferred.promise;
	},
	
	onAuthComplete: async function(url, tab) {
		// close auth window
		// ensure that tab close listeners don't have a promise they can reject
		let deferred = this.authDeferred;
		this.authDeferred = null;
		if (Zotero.isBrowserExt) {
			browser.tabs.remove(tab.id);
		} else if (Zotero.isSafari) {
			Zotero.Connector_Browser.closeTab(tab);
		}
		try {
			var uri = new URL(url);
			var params = {};
			for (let keyvalue of uri.hash.split('&')) {
				let [key, value] = keyvalue.split('=');
				params[key] = decodeURIComponent(value);
			}
			let error = params.error || params['#error'];
			if (error) {
				if (error === 'access_denied') {
					throw new Error(`Google Auth permission to access Google Docs not granted`);
				}
				else {
					throw new Error(error);
				}
			}
			
			if (!params.scope.includes("https://www.googleapis.com/auth/documents")) {
				throw new Error(`Google Auth permission to access Google Docs not granted`);
			}
			
			url = ZOTERO_CONFIG.OAUTH.GOOGLE_DOCS.ACCESS_URL
				+ `?access_token=${params.access_token}`;
			let xhr = await Zotero.HTTP.request('GET', url);
			let response = JSON.parse(xhr.responseText);
			if (response.aud != ZOTERO_CONFIG.OAUTH.GOOGLE_DOCS.CLIENT_KEY) {
				throw new Error(`Google Docs Access Token invalid ${xhr.responseText}`);
			}
			
			this.authCredentials.lastEmail = response.email;
			this.authCredentials.headers = {'Authorization': `Bearer ${params.access_token}`};
			this.authCredentials.expiresAt = Date.now() + (parseInt(params.expires_in)-60)*1000;
			response = await this.getAuthHeaders();
			deferred.resolve(response);
			return response;
		} catch (e) {
			return deferred.reject(e);
		}
	},
	
	onAuthCancel: function() {
		let error = new Error('Google Docs authorization was cancelled');
		error.type = "Alert";
		Zotero.GoogleDocs.API.authDeferred
			&& Zotero.GoogleDocs.API.authDeferred.reject(error);
	},
	
	run: async function(documentSpecifier, method, args, tab) {
		// If not an array, discard or the docs script spews errors.
		if (! Array.isArray(args)) {
			args = [];
		}
		let headers;
		try {
			headers = await this.getAuthHeaders();
		}
		catch (e) {
			if (e.message.includes('not granted')) {
				this.displayPermissionsNotGrantedPrompt(tab)
				throw new Error('Handled Error');
			}
			else {
				throw e;
			}
		}
		headers["Content-Type"] = "application/json";
		var body = {
			function: 'callMethod',
			parameters: [documentSpecifier, method, args, Zotero.GoogleDocs.API.apiVersion],
			devMode: ZOTERO_CONFIG.GOOGLE_DOCS_DEV_MODE
		};
		try {
			var xhr = await Zotero.HTTP.request('POST', ZOTERO_CONFIG.GOOGLE_DOCS_API_URL,
				{headers, body, timeout: null});
		} catch (e) {
			if (e.status >= 400 && e.status < 404) {
				this.resetAuth();
				this.displayWrongAccountPrompt();
				throw new Error('Handled Error');
			} else if (e.status){
				throw new Error(`${e.status}: Google Docs request failed.\n\n${e.responseText}`);
			}
			else {
				throw e;
			}
		}
		var responseJSON = JSON.parse(xhr.responseText);
		
		if (responseJSON.error) {
			// For some reason, sometimes the still valid auth token starts being rejected
			if (responseJSON.error.details[0].errorMessage == "Authorization is required to perform that action.") {
				delete this.authCredentials.headers;
				return this.run(documentSpecifier, method, args);
			}
			var err = new Error(responseJSON.error.details[0].errorMessage);
			err.stack = responseJSON.error.details[0].scriptStackTraceElements;
			err.type = `Google Docs ${responseJSON.error.message}`;
			throw err;
		}
		
		let resp = await this.handleResponseErrors(responseJSON, arguments, tab);
		if (resp) {
			return resp;
		}
		var response = responseJSON.response.result && responseJSON.response.result.response;
		if (responseJSON.response.result.debug) {
			Zotero.debug(`Google Docs debug:\n\n${responseJSON.response.result.debug.join('\n\n')}`);
		}
		return response;
	},
	
	handleResponseErrors: async function(responseJSON, args, tab) {
		var lockError = responseJSON.response.result.lockError;
		if (lockError) {
			if (await this.displayLockErrorPrompt(lockError, tab)) {
				await this.run(args[0], "unlockTheDoc", [], args[3]);
				return this.run.apply(this, args);
			} else {
				throw new Error('Handled Error');
			}
		}
		var docAccessError = responseJSON.response.result.docAccessError;
		if (docAccessError) {
			this.resetAuth();
			this.displayWrongAccountPrompt();
			throw new Error('Handled Error');
		}
		var genericError = responseJSON.response.result.error;
		if (genericError) {
			Zotero.logError(new Error(`Non-fatal Google Docs Error: ${genericError}`));
		}
	},

	displayLockErrorPrompt: async function(error, tab) {
		var message = Zotero.getString('integration_googleDocs_documentLocked', ZOTERO_CONFIG.CLIENT_NAME);
		var result = await Zotero.Messaging.sendMessage('confirm', {
			title: ZOTERO_CONFIG.CLIENT_NAME,
			button2Text: "",
			button3Text: Zotero.getString('general_needHelp'),
			message
		}, tab);
		if (result.button != 3) return;

		message = Zotero.getString('integration_googleDocs_documentLocked_moreInfo', ZOTERO_CONFIG.CLIENT_NAME);
		
		var result = await Zotero.Messaging.sendMessage('confirm', {
			title: ZOTERO_CONFIG.CLIENT_NAME,
			button1Text: Zotero.getString('general_yes'),
			button2Text: Zotero.getString('general_no'),
			message
		}, tab);
		return result.button == 1;
	},
	
	displayPermissionsNotGrantedPrompt: async function(tab) {
		var message = Zotero.getString('integration_googleDocs_authScopeError', ZOTERO_CONFIG.CLIENT_NAME);
		var result = await Zotero.Messaging.sendMessage('confirm', {
			title: ZOTERO_CONFIG.CLIENT_NAME,
			button2Text: "",
			button3Text: Zotero.getString('general_moreInfo'),
			message
		}, tab);
		if (result.button != 3) return;
		Zotero.Connector_Browser.openTab('https://www.zotero.org/support/google_docs#authorization');
	},
	
	displayWrongAccountPrompt: async function(tab) {
		var message = Zotero.getString('integration_googleDocs_documentPermissionError', ZOTERO_CONFIG.CLIENT_NAME);
		var result = await Zotero.Messaging.sendMessage('confirm', {
			title: ZOTERO_CONFIG.CLIENT_NAME,
			button2Text: "",
			button3Text: Zotero.getString('general_moreInfo'),
			message
		}, tab);
		if (result.button != 3) return;
		Zotero.Connector_Browser.openTab('https://www.zotero.org/support/google_docs#authorization');
	},

	getDocument: async function (docID, tabId=null) {
		var headers = await this.getAuthHeaders();
		headers["Content-Type"] = "application/json";
		try {
			var xhr = await Zotero.HTTP.request('GET', `https://docs.googleapis.com/v1/documents/${docID}?includeTabsContent=true`,
				{headers, timeout: 60000});

			delete Zotero.GoogleDocs.API.V2BrokenDocsById[docID];
		} catch (e) {
			if (e.status == 403) {
				this.resetAuth();
				this.displayWrongAccountPrompt();
				throw new Error('Handled Error');
			} else if (e.status == 500) {
				// Report 500 errors to the repository
				try {
					Zotero.GoogleDocs.API.V2BrokenDocsById[docID] = (Zotero.GoogleDocs.API.V2BrokenDocsById[docID] || 0) + 1;
					Zotero.debug(`Reporting Google Docs API error for document ${docID}. Count: ${Zotero.GoogleDocs.API.V2BrokenDocsById[docID]}`);
					// Use SHA-256 to hash the document ID to avoid leaking the document ID
					// But so that we can track the number of errors for the same document
					// Since users may be working on multiple docs at once
					const hashDocID = await this._sha256(docID);
					var parts = {
						error: "true",
						errorData: "googleDocsV2APIError",
						extraData: JSON.stringify({ count: Zotero.GoogleDocs.API.V2BrokenDocsById[docID], docID: hashDocID }),
						diagnostic: await Zotero.Errors.getSystemInfo()
					};
					
					var body = '';
					for (var key in parts) {
						body += key + '=' + encodeURIComponent(parts[key]) + '&';
					}
					body = body.substr(0, body.length - 1);
					let reportHeaders = {'Content-Type': 'application/x-www-form-urlencoded'};
					let options = {body, headers: reportHeaders};
					await Zotero.HTTP.request("POST", ZOTERO_CONFIG.REPOSITORY_URL + "report", options);
				} catch (reportError) {
					Zotero.debug('Failed to report Google Docs API error: ' + reportError.message);
				}
				throw new Error(`${e.status}: Google Docs request failed.\n\n${e.responseText}`);
			} else {
				if (e.status) {
					throw new Error(`${e.status}: Google Docs request failed.\n\n${e.responseText}`);
				}
				else {
					throw e;
				}
			}
		}
		
		let document = JSON.parse(xhr.responseText);
		if (!document.tabs) return document;
		let documentTab = this._getDocumentTabFromTabs(document.tabs, tabId);
		if (documentTab) {
			documentTab.documentId = docID;
			documentTab.tabId = tabId;
		}
		return documentTab;
	},
	
	_getDocumentTabFromTabs: function(tabs, tabId=null) {
		for (let tab of tabs) {
			// Return first tab if not specified
			if (tabId === null || tab.tabProperties.tabId == tabId) {
				return tab.documentTab;
			}
			if (tab.childTabs) {
				let documentTab = this._getDocumentTabFromTabs(tab.childTabs, tabId);
				if (documentTab) return documentTab;
			}
		}
		return null;
	},
	
	_addTabDataToObject(object, tabId) {
		const key = Object.keys(object)[0];
		if (TABS_CRITERIA_METHODS.has(key)) {
			object[key].tabsCriteria = { tabIds: [tabId] }
			return;
		}
		else if (TAB_ID_METHODS.has(key)) {
			object.tabId = tabId;
		}
		for (let k in object[key]) {
			if (TAB_ID_PARAMS.has(k)) {
				object[key][k].tabId = tabId;
			}
		}
	},

	_sha256: async function(str) {
		const arrayBuffer = new TextEncoder().encode(str); // encode as (utf-8) Uint8Array
		const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", arrayBuffer); // hash the message
		const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
		const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join(""); // convert bytes to hex string
		return hashHex;
	},

	batchUpdateDocument: async function (docId, tabId=null, body) {
		var headers = await this.getAuthHeaders();
		if (tabId) {
			for (let request of body.requests) {
				request = this._addTabDataToObject(request, tabId);
			}
		}
		try {
			var xhr = await Zotero.HTTP.request('POST', `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
				{headers, body, timeout: 60000});
		} catch (e) {
			if (e.status == 403) {
				this.resetAuth();
				this.displayWrongAccountPrompt();
				throw new Error('Handled Error');
			} else {
				throw new Error(`${e.status}: Google Docs request failed.\n\n${e.responseText}`);
			}
		}

		return JSON.parse(xhr.responseText);
	}
};

Zotero.GoogleDocs_API = Zotero.GoogleDocs.API;

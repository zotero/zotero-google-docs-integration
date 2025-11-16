# Concurrent Editing Reliability Issues

## Summary

The Zotero Google Docs Integration plugin has significant reliability issues when multiple users edit the same document simultaneously. The current implementation assumes single-user editing and lacks proper conflict resolution mechanisms, leading to failed operations, orphaned citations, and potential data corruption.

## Critical Issues

### 1. Non-Atomic Lock Mechanism (Apps Script Mode)

**Location**: `src/apps-script/Code.js:402-412`

The lock implementation explicitly acknowledges it's not atomic:

```javascript
function lockTheDoc() {
    if (checkIfLocked()) {
        throw new LockError('The document citations are being edited by another Zotero user. Please try again later.');
    }
    doc.addNamedRange(LOCK_NAME, bodyRange);
    // Saves the doc so that the newly added lock range is visible to other script invocations.
    // Unfortunately no API to just save the doc without closing it.
    // The locking process here is quite obviously not an atomic operation, which is
    // far from ideal, but that's the best we have and better than naught
    _doc.saveAndClose();
    getDocument();

    return doc;
}
```

**Problem**: Race condition exists between:
1. Line 403: Check if locked (`checkIfLocked()`)
2. Line 406: Add lock (`doc.addNamedRange(LOCK_NAME, bodyRange)`)
3. Line 411: Save document (`_doc.saveAndClose()`)

Two users can both pass the lock check and both believe they have exclusive access.

**Impact**:
- Multiple users can simultaneously modify citation data
- One user's changes may be overwritten by another
- Unpredictable behavior when operations interleave

---

### 2. No Conflict Resolution on Stale Revisions (V2 API Mode)

**Location**: `src/connector/document.js:62-68`

The V2 API uses Google's optimistic locking via revision IDs:

```javascript
let requestBody = { writeControl: { targetRevisionId: this.revisionId } };
requestBody.requests = this._batchedUpdates;
this._batchedUpdates = [];
let response = await Zotero.GoogleDocs_API.batchUpdateDocument(this.documentId, this.tabId, requestBody);
this.revisionId = response.writeControl.requiredRevisionId;
```

**Location**: `src/connector/api.js:376-387`

Error handling for `batchUpdateDocument`:

```javascript
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
```

**Problem**:
- When `targetRevisionId` is stale (document modified by another user), Google API returns 400 status
- No specific handling for 400 errors - operation fails with generic error message
- No retry logic, no automatic refetch, no user notification of conflict
- The entire transaction is lost

**Impact**:
- Any concurrent edit causes citation operations to fail
- User sees cryptic "Google Docs request failed" error
- Must manually retry entire operation
- Data consistency not guaranteed

---

### 3. Stale Position Indices During Concurrent Edits

**Location**: `src/connector/document.js:40-43`

Document positions calculated at fetch time:

```javascript
this.bodyRange = {
    startIndex: 0,
    endIndex: this.body.content[this.body.content.length-1].endIndex,
};
```

**Location**: `src/connector/document.js:118-124` (example usage)

```javascript
this.addBatchedUpdate('insertText', { text: docData,
    location: { index: this.bodyRange.endIndex-1, } });
this.addBatchedUpdate('updateTextStyle', {
    textStyle: { link: { url: config.fieldURL } },
    fields: 'link',
    range: { startIndex: this.bodyRange.endIndex-1, endIndex: this.bodyRange.endIndex-1 + docData.length }
});
```

**Problem**:
- Document fetched at revision N with specific text positions
- User calculates insert/update positions based on this snapshot
- Another user inserts/deletes text, shifting all positions
- Original user commits with now-incorrect absolute positions
- While NamedRanges auto-adjust after creation, initial positioning uses stale data

**Impact**:
- Text inserted at wrong locations
- Citations may appear in incorrect document positions
- Field codes may fail to link properly → orphaned citations

---

### 4. Orphaned Citations Without Recovery

**Location**: `src/apps-script/Code.js:262-291`

```javascript
function handleOrphanedCitation(link) {
    if (apiVersion < 5) {
        // Unlink orphaned links
        link.text.setLinkUrl(link.startOffset, link.endOffsetInclusive, null);
        debug('Unlinking orphaned link: "' + link.url + '": ' + link.url);
        return;
    }
    var text = link.text.getText().substring(link.startOffset, link.endOffsetInclusive+1);
    var key = link.url.substr(config.fieldURL.length);
    if (key.indexOf('broken=') === 0) {
        key = key.substr('broken='.length);
    } else {
        // Assign a new key in case the citation was copied and the original
        // one is still intact and has a working key. The url-key is later used
        // to select the orphaned citation in the UI
        key = randomString(config.fieldKeyLength)
    }
    orphanedCitations.push({
        url: config.brokenFieldURL + key,
        text: text,
        key: key
    });
    // Already processed previously
    if (link.url.indexOf(config.brokenFieldURL) === 0) return;

    debug('Found a new orphaned citation: "' + link.url + '": ' + text);
    link.text.setLinkUrl(link.startOffset, link.endOffsetInclusive, config.brokenFieldURL + key);
    // Set red text color for unlinked citations
    var attr = {};
    attr[DocumentApp.Attribute.FOREGROUND_COLOR] = "#cc2936";
```

**Location**: `src/apps-script/Code.js:153-161`

Orphaned citations detected during field retrieval:

```javascript
} else if (link.text.getText().substring(link.startOffset, link.endOffsetInclusive+1) == config.citationPlaceholder) {
    if (removePlaceholder) {
        link.text.deleteText(link.startOffset, link.endOffsetInclusive);
    }
    insertIdx = idx;
} else if (key) {
    handleOrphanedCitation(link);
}
```

**Problem**:
- Orphaned citations occur when citation links exist but their NamedRange field codes are missing
- System detects these and marks them with red text and special "broken" URL
- No automatic recovery mechanism
- User must manually resolve via Zotero UI

**Impact**:
- Citations become non-functional (can't update, refresh, or regenerate bibliography)
- Red text alerts users but provides no automatic fix
- Requires manual intervention to restore document integrity
- Can cascade into multiple orphaned citations if not caught early

---

## Failure Scenarios

### Scenario 1: Simultaneous Citation Insertion

**Steps**:
1. User A clicks "Add Citation" at position 100
2. User B clicks "Add Citation" at position 200
3. Both operations start simultaneously

**Apps Script Mode Result**:
- Both users may pass `checkIfLocked()` before either sets the lock
- Both acquire lock, both make changes
- Last one to commit wins, first user's work silently lost

**V2 API Mode Result**:
- Both fetch document at revision N
- User A commits first → succeeds, document now at revision N+1
- User B commits with `targetRevisionId: N` → 400 error, operation fails
- User B sees "Google Docs request failed" error
- User B must retry entire operation

---

### Scenario 2: Text Editing During Citation Update

**Steps**:
1. User A triggers "Refresh" to update all citations
2. Zotero fetches document, calculates positions for 50 citations
3. User B types a paragraph at the beginning of the document
4. Zotero commits batched updates with stale position indices

**Result**:
- All positions shifted by paragraph length
- Citations may be inserted at wrong locations
- NamedRanges may fail to link to citation text
- Multiple orphaned citations created
- Bibliography becomes desynchronized

---

### Scenario 3: Concurrent Bibliography Regeneration

**Steps**:
1. User A clicks "Refresh"
2. User B clicks "Refresh" 1 second later
3. Both operations fetch current document state
4. Both calculate bibliography updates

**Apps Script Mode Result**:
- Race to acquire lock
- One operation fails with lock error
- User must click through error dialog and retry

**V2 API Mode Result**:
- First to commit succeeds
- Second gets 400 revision conflict
- Second operation fails completely
- May leave document in inconsistent state (citations refreshed but not bibliography, or vice versa)

---

## Recommendations

### Immediate Improvements

1. **Add 400 Error Handling in V2 API** (`src/connector/api.js:376-387`)
   - Detect stale revision conflicts (HTTP 400)
   - Implement automatic retry with exponential backoff
   - Refetch document and recalculate positions
   - Limit to 3 retry attempts before failing with clear user message

2. **User Notification for Concurrent Editing**
   - Detect when document changed during operation
   - Show clear warning: "Document was modified by another user. Retrying..."
   - Provide option to cancel if multiple retries fail

3. **Improved Lock Error Messaging** (`src/connector/api.js:225-243`)
   - Currently exists but could be more actionable
   - Add automatic retry option instead of just "Need Help?"

### Long-term Solutions

4. **Transaction-Based Updates with Rollback**
   - Track all changes in operation
   - On conflict, revert partial changes
   - Guarantee atomic all-or-nothing updates

5. **Real-Time Conflict Detection**
   - Monitor document changes during long operations
   - Abort early if concurrent edit detected
   - Prevent corrupted state before commit

6. **Field Code Redundancy**
   - Store backup of field codes in multiple locations
   - Automatic orphaned citation recovery
   - Self-healing on next operation

7. **Document-Level Operation Queue**
   - Serialize Zotero operations per document
   - Prevent multiple users from same Zotero instance from conflicting
   - Coordinate between browser tabs

---

## Testing Recommendations

To reproduce and verify fixes:

1. **Two Users, Simultaneous Insert**
   - Two people open same document
   - Both click "Add Citation" within 1 second
   - Verify both citations inserted correctly
   - Verify no orphaned citations created

2. **Edit During Refresh**
   - User A clicks "Refresh" on document with 20+ citations
   - User B immediately starts typing at document start
   - Verify all citations remain functional
   - Verify no position corruption

3. **Rapid Successive Operations**
   - User A clicks "Add Citation"
   - User A immediately clicks "Refresh" before first operation completes
   - Verify both operations complete or fail gracefully
   - Verify clear error messages if conflict occurs

---

## Additional Context

**Current Behavior**: The plugin is designed for single-user editing. The comment in `src/apps-script/Code.js:409-410` explicitly acknowledges the lock is "far from ideal, but that's the best we have and better than naught."

**User Impact**: Organizations using Google Docs for collaborative writing with Zotero will experience:
- Frequent operation failures requiring manual retries
- Orphaned citations requiring manual cleanup
- Potential data loss when citations are overwritten
- Poor user experience with cryptic error messages

**Severity**: High - Affects core functionality in multi-user scenarios

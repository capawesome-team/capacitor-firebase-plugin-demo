// Regression cases for @capacitor-firebase/firestore on Android and iOS.
// Runs inside the app WebView and calls the native plugin directly, so the JavaScript wrapper plays no role.
// Defines globalThis.__regressionRun(phase, env) with phase 'main', 'settingsA' or 'settingsB'.
// env.host is the emulator host as seen from the device. env.onLine(line, lines) is an optional sink.
(function () {
  const PLUGIN = 'FirebaseFirestore';
  const PORT = 8080;
  const SERVER_TIME_PREFIX = 'serverTime';
  const GENERATED_ID = /^[A-Za-z0-9]{20}$/;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(condition, timeoutMs) {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) {
        return false;
      }
      await wait(50);
    }
    return true;
  }

  const timestamp = (seconds, nanoseconds = 0) => ({ __type__: 'timestamp', seconds, nanoseconds });
  const geopoint = (latitude, longitude) => ({ __type__: 'geopoint', latitude, longitude });
  const documentReference = (path) => ({
    __type__: 'documentReference',
    id: path.substring(path.lastIndexOf('/') + 1),
    path,
  });
  const bytes = (base64) => ({ __type__: 'bytes', bytes: base64 });
  const specialNumber = (value) => ({ __type__: 'number', value });
  const serverTimestamp = () => ({ __type__: 'serverTimestamp' });
  const arrayUnion = (...elements) => ({ __type__: 'arrayUnion', elements });
  const arrayRemove = (...elements) => ({ __type__: 'arrayRemove', elements });
  const deleteField = () => ({ __type__: 'delete' });
  const increment = (operand) => ({ __type__: 'increment', operand });
  const where = (fieldPath, opStr, value) => ({ type: 'where', fieldPath, opStr, value });
  const and = (...queryConstraints) => ({ type: 'and', queryConstraints });
  const or = (...queryConstraints) => ({ type: 'or', queryConstraints });
  const orderBy = (fieldPath, directionStr) => ({ type: 'orderBy', fieldPath, directionStr });
  const limit = (type, value) => ({ type, limit: value });
  const cursor = (type, reference) => ({ type, reference });

  function createRunner(env) {
    const lines = [];
    const generatedIds = new Set();

    function isPlausibleServerTimestamp(value) {
      if (!value || typeof value !== 'object' || value.__type__ !== 'timestamp') {
        return false;
      }
      const { seconds, nanoseconds } = value;
      const nowSeconds = Date.now() / 1000;
      return (
        Number.isInteger(seconds) &&
        Number.isInteger(nanoseconds) &&
        nanoseconds >= 0 &&
        nanoseconds < 1e9 &&
        Math.abs(seconds - nowSeconds) < 2 * 86400
      );
    }

    function normalize(value, key) {
      if (typeof key === 'string' && key.startsWith(SERVER_TIME_PREFIX) && value !== null && value !== '<serverTimestamp>') {
        return isPlausibleServerTimestamp(value) ? '<serverTimestamp>' : `<unexpected serverTimestamp ${JSON.stringify(value)}>`;
      }
      if (value === undefined) {
        return '<undefined>';
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        return `<raw number ${String(value)}>`;
      }
      if (typeof value === 'string') {
        let result = value;
        for (const id of generatedIds) {
          result = result.split(id).join('<id>');
        }
        return result;
      }
      if (Array.isArray(value)) {
        return value.map((item) => normalize(item));
      }
      if (value && typeof value === 'object') {
        const result = {};
        for (const childKey of Object.keys(value).sort()) {
          result[childKey] = normalize(value[childKey], childKey);
        }
        return result;
      }
      return value;
    }

    const serialize = (value) => JSON.stringify(normalize(value));

    async function emit(caseId, step, value) {
      const isNotRun = typeof value === 'string' && value.startsWith('NOT RUN');
      const line = `CASE ${caseId} ${step}: ${isNotRun ? value : serialize(value)}`;
      lines.push(line);
      console.log('REGRESSION ' + line);
      if (env.onLine) {
        await env.onLine(line, lines);
      }
    }

    function toError(error) {
      return { error: { message: error && error.message, code: (error && error.code) ?? null } };
    }

    function call(method, options) {
      return Capacitor.nativePromise(PLUGIN, method, options || {}).then(
        (result) => ({ result }),
        (error) => toError(error),
      );
    }

    async function step(caseId, name, method, options) {
      const outcome = await call(method, options);
      await emit(caseId, name, outcome);
      return outcome;
    }

    async function stepWithTimeout(caseId, name, method, options, timeoutMs) {
      const outcome = await Promise.race([
        call(method, options).then((value) => ({ settled: true, ...value })),
        wait(timeoutMs).then(() => ({ settled: false })),
      ]);
      await emit(caseId, name, outcome);
      return outcome;
    }

    async function addDocument(caseId, name, options) {
      const outcome = await call('addDocument', options);
      const id = outcome.result && outcome.result.reference && outcome.result.reference.id;
      if (typeof id === 'string' && GENERATED_ID.test(id)) {
        generatedIds.add(id);
      } else if (outcome.result) {
        outcome.invalidGeneratedId = String(id);
      }
      await emit(caseId, name, outcome);
      return outcome;
    }

    function eventData(event) {
      if (!event || event.error) {
        return event;
      }
      if (event.snapshot !== undefined) {
        return event.snapshot ? event.snapshot.data : event.snapshot;
      }
      if (Array.isArray(event.snapshots)) {
        return event.snapshots.map((snapshot) => ({ id: snapshot.id, data: snapshot.data }));
      }
      return event;
    }

    function addListener(method, options) {
      const listener = { events: [], printedCount: 0, lastKey: null, isRemoved: false, eventsAfterRemove: 0 };
      listener.callbackId = Capacitor.nativeCallback(PLUGIN, method, options, (event, error) => {
        if (listener.isRemoved) {
          listener.eventsAfterRemove++;
          return;
        }
        listener.events.push(error ? toError(error) : event);
      });
      return listener;
    }

    function takeNewEvents(listener) {
      const values = [];
      for (const event of listener.events.slice(listener.printedCount)) {
        const value = normalize(eventData(event));
        const key = JSON.stringify(value);
        if (key !== listener.lastKey) {
          values.push(value);
          listener.lastKey = key;
        }
      }
      listener.printedCount = listener.events.length;
      return values;
    }

    async function waitForEvents(listener, count) {
      const isReceived = await waitFor(() => listener.events.length >= count, 10000);
      await wait(1500);
      return isReceived;
    }

    async function listenerCase(caseId, method, options, firstWrite, writeAfterRemove) {
      const listener = addListener(method, options);
      const isFirstReceived = await waitForEvents(listener, 1);
      await emit(caseId, 'firstEvents', { events: takeNewEvents(listener), isReceived: isFirstReceived });
      const countBeforeWrite = listener.events.length;
      await emit(caseId, 'write', await firstWrite());
      const isNextReceived = await waitForEvents(listener, countBeforeWrite + 1);
      await emit(caseId, 'nextEvents', { events: takeNewEvents(listener), isReceived: isNextReceived });
      listener.isRemoved = true;
      await step(caseId, 'removeSnapshotListener', 'removeSnapshotListener', { callbackId: listener.callbackId });
      await emit(caseId, 'writeAfterRemove', await writeAfterRemove());
      await wait(2000);
      await emit(caseId, 'eventsAfterRemove', { count: listener.eventsAfterRemove });
    }

    async function listenerWithoutReference(caseId, name, method) {
      let firstCallback = null;
      Capacitor.nativeCallback(PLUGIN, method, {}, (event, error) => {
        if (firstCallback === null) {
          firstCallback = error ? toError(error) : { event };
        }
      });
      const isReceived = await waitFor(() => firstCallback !== null, 5000);
      await emit(caseId, name, isReceived ? firstCallback : { noCallbackWithinMs: 5000 });
    }

    const set = (reference, data, merge) => call('setDocument', merge === undefined ? { reference, data } : { reference, data, merge });

    async function seed(caseId, documents) {
      for (const [reference, data] of documents) {
        await step(caseId, `seed ${reference}`, 'setDocument', { reference, data });
      }
    }

    async function caseDocuments() {
      await step(1, 'setDocument', 'setDocument', { reference: 'docs/a', data: { name: 'a', count: 1, tags: ['x'] } });
      await step(1, 'getDocument', 'getDocument', { reference: 'docs/a' });
      await step(1, 'setDocumentMerge', 'setDocument', { reference: 'docs/a', data: { count: 2 }, merge: true });
      await step(1, 'getDocumentAfterMerge', 'getDocument', { reference: 'docs/a' });
      await step(1, 'setDocumentWithoutMerge', 'setDocument', { reference: 'docs/a', data: { other: true }, merge: false });
      await step(1, 'getDocumentAfterOverwrite', 'getDocument', { reference: 'docs/a' });
      await step(1, 'getDocumentMissing', 'getDocument', { reference: 'docs/missing' });
      await step(1, 'updateDocument', 'updateDocument', { reference: 'docs/a', data: { count: 5, 'nested.inner': 'v' } });
      await step(1, 'getDocumentAfterUpdate', 'getDocument', { reference: 'docs/a' });
      await step(1, 'deleteDocument', 'deleteDocument', { reference: 'docs/a' });
      await step(1, 'getDocumentAfterDelete', 'getDocument', { reference: 'docs/a' });
      const added = await addDocument(1, 'addDocument', { reference: 'added', data: { name: 'added' } });
      const path = added.result && added.result.reference && added.result.reference.path;
      if (typeof path === 'string') {
        await step(1, 'getDocumentAdded', 'getDocument', { reference: path });
      } else {
        await emit(1, 'getDocumentAdded', 'NOT RUN addDocument returned no path');
      }
    }

    async function caseDataTypes() {
      const data = {
        string: 'hello',
        stringUnicode: 'äöü ✓',
        stringNull: 'null',
        stringEmpty: '',
        integer: 42,
        integerZero: 0,
        integerNegative: -7,
        integerMaxSafe: 9007199254740991,
        double: 1.5,
        doubleNegative: -0.25,
        booleanTrue: true,
        booleanFalse: false,
        nullValue: null,
        array: [1, 'two', true, null],
        arrayEmpty: [],
        arrayOfMarkers: [timestamp(1700000000, 0), geopoint(1, 2)],
        map: { nested: { level: 2, list: ['a', 'b'] } },
        mapEmpty: {},
        mapOfMarkers: { reference: documentReference('types/other'), bytes: bytes('AAEC') },
        timestamp: timestamp(1700000000, 123000000),
        geopoint: geopoint(52.52, 13.405),
        reference: documentReference('types/doc1'),
        bytes: bytes('AQID'),
        nan: specialNumber('NaN'),
        infinity: specialNumber('Infinity'),
        negativeInfinity: specialNumber('-Infinity'),
      };
      await step(2, 'setDocumentAllTypes', 'setDocument', { reference: 'types/all', data });
      await step(2, 'getDocumentAllTypes', 'getDocument', { reference: 'types/all' });
      // One document per type, so that one failing type does not hide the others.
      for (const field of Object.keys(data)) {
        await step(2, `setDocument ${field}`, 'setDocument', { reference: `types/${field}`, data: { value: data[field] } });
        await step(2, `getDocument ${field}`, 'getDocument', { reference: `types/${field}` });
      }
    }

    async function caseFieldValues() {
      await step(3, 'seed', 'setDocument', { reference: 'fv/a', data: { tags: ['a', 'b'], counter: 1, toDelete: 'x', keep: 'y' } });
      await step(3, 'setDocumentMerge', 'setDocument', {
        reference: 'fv/a',
        data: { serverTime: serverTimestamp(), tags: arrayUnion('c', 'a'), counter: increment(2), toDelete: deleteField() },
        merge: true,
      });
      await step(3, 'getDocumentAfterSetMerge', 'getDocument', { reference: 'fv/a' });
      await step(3, 'updateDocument', 'updateDocument', {
        reference: 'fv/a',
        data: { serverTime2: serverTimestamp(), tags: arrayRemove('a'), counter: increment(0.5), keep: deleteField() },
      });
      await step(3, 'getDocumentAfterUpdate', 'getDocument', { reference: 'fv/a' });
    }

    async function caseWriteBatch() {
      await seed(4, [
        ['batch/a', { v: 1, keep: true }],
        ['batch/b', { v: 2 }],
        ['batch/c', { v: 3 }],
      ]);
      await step(4, 'writeBatch', 'writeBatch', {
        operations: [
          { type: 'set', reference: 'batch/new', data: { v: 'new' } },
          { type: 'set', reference: 'batch/a', data: { added: 'merged' }, options: { merge: true } },
          { type: 'update', reference: 'batch/b', data: { v: 20 } },
          { type: 'delete', reference: 'batch/c' },
        ],
      });
      await step(4, 'getCollection', 'getCollection', { reference: 'batch' });
    }

    async function caseQueries() {
      const documents = [
        ['q/d1', { n: 1, group: 'a', active: true, tags: ['red'], ts: timestamp(1700000001), ref: documentReference('refs/r3') }],
        ['q/d2', { n: 2, group: 'a', active: false, tags: ['red', 'blue'], ts: timestamp(1700000002), ref: documentReference('refs/r1') }],
        ['q/d3', { n: 3, group: 'b', active: true, tags: ['blue'], ts: timestamp(1700000003), ref: documentReference('refs/r2') }],
        ['q/d4', { n: 4, group: 'b', active: false, tags: ['green'], ts: timestamp(1700000004), ref: documentReference('refs/r1') }],
        ['q/d5', { n: 5, group: 'c', active: true, tags: [], ts: timestamp(1700000005), ref: documentReference('refs/r3') }],
        ['q/d6', { n: 6, group: 'c', active: false, tags: ['red', 'green'], ts: timestamp(1700000006), ref: documentReference('refs/r2') }],
      ];
      await seed(5, documents);
      const query = (name, options) => step(5, name, 'getCollection', { reference: 'q', ...options });
      const filter = (constraint) => ({ compositeFilter: and(constraint) });
      await query('noConstraint', {});
      await query('where==', filter(where('group', '==', 'a')));
      await query('where!=', filter(where('group', '!=', 'a')));
      await query('where<', filter(where('n', '<', 3)));
      await query('where<=', filter(where('n', '<=', 3)));
      await query('where>', filter(where('n', '>', 4)));
      await query('where>=', filter(where('n', '>=', 4)));
      await query('whereArrayContains', filter(where('tags', 'array-contains', 'red')));
      await query('whereArrayContainsAny', filter(where('tags', 'array-contains-any', ['blue', 'green'])));
      await query('whereIn', filter(where('group', 'in', ['a', 'c'])));
      await query('whereNotIn', filter(where('group', 'not-in', ['a', 'c'])));
      await query('compositeAnd', { compositeFilter: and(where('group', '==', 'b'), where('active', '==', true)) });
      await query('compositeOr', { compositeFilter: or(where('n', '==', 1), where('n', '==', 6)) });
      await query('compositeOrOfAnd', {
        compositeFilter: or(and(where('group', '==', 'a'), where('active', '==', false)), and(where('group', '==', 'c'), where('active', '==', true))),
      });
      await query('compositeAndOfOr', {
        compositeFilter: and(where('n', '>=', 2), or(where('group', '==', 'a'), where('group', '==', 'c'))),
      });
      await query('orderByAsc', { queryConstraints: [orderBy('n', 'asc')] });
      await query('orderByDesc', { queryConstraints: [orderBy('n', 'desc')] });
      await query('limit', { queryConstraints: [limit('limit', 2)] });
      await query('orderByDescLimit', { queryConstraints: [orderBy('n', 'desc'), limit('limit', 2)] });
      await query('orderByAscLimitToLast', { queryConstraints: [orderBy('n', 'asc'), limit('limitToLast', 2)] });
      await query('startAt', { queryConstraints: [orderBy('n', 'asc'), cursor('startAt', 'q/d3')] });
      await query('startAfter', { queryConstraints: [orderBy('n', 'asc'), cursor('startAfter', 'q/d3')] });
      await query('endAt', { queryConstraints: [orderBy('n', 'asc'), cursor('endAt', 'q/d3')] });
      await query('endBefore', { queryConstraints: [orderBy('n', 'asc'), cursor('endBefore', 'q/d3')] });
      await query('startAtWithoutOrderBy', { queryConstraints: [cursor('startAt', 'q/d5')] });
      await query('whereTimestamp', filter(where('ts', '>', timestamp(1700000003))));
      await query('whereDocumentReference', filter(where('ref', '==', documentReference('refs/r1'))));
    }

    async function caseCollectionGroup() {
      await seed(6, [
        ['cg/p1/items/i1', { n: 1, kind: 'x' }],
        ['cg/p1/items/i2', { n: 2, kind: 'y' }],
        ['cg/p2/items/i3', { n: 3, kind: 'x' }],
        ['cg/p2/others/o1', { n: 9, kind: 'x' }],
      ]);
      await step(6, 'getCollectionGroup', 'getCollectionGroup', { reference: 'items' });
      await step(6, 'getCollectionGroupWithFilter', 'getCollectionGroup', {
        reference: 'items',
        compositeFilter: and(where('kind', '==', 'x')),
      });
    }

    async function caseCount() {
      await step(7, 'getCountFromServer', 'getCountFromServer', { reference: 'q' });
      await step(7, 'getCountFromServerWithFilter', 'getCountFromServer', {
        reference: 'q',
        compositeFilter: and(where('group', '==', 'a')),
      });
    }

    async function caseListeners() {
      await seed('8a', [['listen/doc', { v: 1 }]]);
      await listenerCase(
        '8a',
        'addDocumentSnapshotListener',
        { reference: 'listen/doc' },
        () => set('listen/doc', { v: 2 }),
        () => set('listen/doc', { v: 3 }),
      );

      await seed('8b', [['listen/meta', { v: 1 }]]);
      await listenerCase(
        '8b',
        'addDocumentSnapshotListener',
        { reference: 'listen/meta', includeMetadataChanges: true },
        () => set('listen/meta', { v: 2 }),
        () => set('listen/meta', { v: 3 }),
      );

      await seed('8c', [['listen/est', { n: 1, serverTime: serverTimestamp() }]]);
      await listenerCase(
        '8c',
        'addDocumentSnapshotListener',
        { reference: 'listen/est', serverTimestamps: 'estimate' },
        () => set('listen/est', { n: 2, serverTime: serverTimestamp() }),
        () => set('listen/est', { n: 3, serverTime: serverTimestamp() }),
      );

      await seed('8d', [
        ['listencol/a', { kind: 'x', v: 1 }],
        ['listencol/b', { kind: 'y', v: 1 }],
      ]);
      await listenerCase(
        '8d',
        'addCollectionSnapshotListener',
        { reference: 'listencol', compositeFilter: and(where('kind', '==', 'x')) },
        () => set('listencol/c', { kind: 'x', v: 2 }),
        () => set('listencol/d', { kind: 'x', v: 3 }),
      );

      await seed('8e', [['lg/p1/grouped/g1', { v: 1 }]]);
      await listenerCase(
        '8e',
        'addCollectionGroupSnapshotListener',
        { reference: 'grouped' },
        () => set('lg/p2/grouped/g2', { v: 2 }),
        () => set('lg/p3/grouped/g3', { v: 3 }),
      );

      await seed('8f', [
        ['listen/all1', { v: 1 }],
        ['listenall/a', { v: 1 }],
      ]);
      const documentListener = addListener('addDocumentSnapshotListener', { reference: 'listen/all1' });
      const collectionListener = addListener('addCollectionSnapshotListener', { reference: 'listenall' });
      const isDocumentReceived = await waitForEvents(documentListener, 1);
      const isCollectionReceived = await waitForEvents(collectionListener, 1);
      await emit('8f', 'firstEvents', {
        collection: takeNewEvents(collectionListener),
        document: takeNewEvents(documentListener),
        isCollectionReceived,
        isDocumentReceived,
      });
      documentListener.isRemoved = true;
      collectionListener.isRemoved = true;
      await step('8f', 'removeAllListeners', 'removeAllListeners', {});
      await emit('8f', 'writeDocument', await set('listen/all1', { v: 2 }));
      await emit('8f', 'writeCollection', await set('listenall/b', { v: 2 }));
      await wait(2000);
      await emit('8f', 'eventsAfterRemove', {
        collection: collectionListener.eventsAfterRemove,
        document: documentListener.eventsAfterRemove,
      });
    }

    async function caseNetwork() {
      await step(9, 'seed', 'setDocument', { reference: 'net/a', data: { v: 1 } });
      await stepWithTimeout(9, 'disableNetwork', 'disableNetwork', {}, 15000);
      await stepWithTimeout(9, 'enableNetwork', 'enableNetwork', {}, 15000);
      await step(9, 'getDocument', 'getDocument', { reference: 'net/a' });
    }

    async function caseMissingArguments() {
      await step(11, 'addDocumentWithoutReference', 'addDocument', { data: { v: 1 } });
      await step(11, 'addDocumentWithoutData', 'addDocument', { reference: 'missing' });
      await step(11, 'setDocumentWithoutReference', 'setDocument', { data: { v: 1 } });
      await step(11, 'setDocumentWithoutData', 'setDocument', { reference: 'missing/args' });
      await step(11, 'getDocumentWithoutReference', 'getDocument', {});
      await step(11, 'updateDocumentWithoutReference', 'updateDocument', { data: { v: 1 } });
      await step(11, 'updateDocumentWithoutData', 'updateDocument', { reference: 'missing/args' });
      await step(11, 'deleteDocumentWithoutReference', 'deleteDocument', {});
      await step(11, 'writeBatchWithoutOperations', 'writeBatch', {});
      await step(11, 'getCollectionWithoutReference', 'getCollection', {});
      await step(11, 'getCollectionGroupWithoutReference', 'getCollectionGroup', {});
      await step(11, 'getCountFromServerWithoutReference', 'getCountFromServer', {});
      await step(11, 'useEmulatorWithoutHost', 'useEmulator', { port: PORT });
      await listenerWithoutReference(11, 'addDocumentSnapshotListenerWithoutReference', 'addDocumentSnapshotListener');
      await listenerWithoutReference(11, 'addCollectionSnapshotListenerWithoutReference', 'addCollectionSnapshotListener');
      await listenerWithoutReference(11, 'addCollectionGroupSnapshotListenerWithoutReference', 'addCollectionGroupSnapshotListener');
      await step(11, 'removeSnapshotListenerWithoutCallbackId', 'removeSnapshotListener', {});
    }

    async function caseSdkError() {
      await step(12, 'updateDocumentMissing', 'updateDocument', { reference: 'docs/never', data: { v: 1 } });
    }

    async function caseRemoveListenerTwice() {
      await step(13, 'removeSnapshotListenerUnknownId', 'removeSnapshotListener', { callbackId: 'regression-unknown-callback-id' });
      await seed(13, [['listen/twice', { v: 1 }]]);
      const listener = addListener('addDocumentSnapshotListener', { reference: 'listen/twice' });
      const isReceived = await waitForEvents(listener, 1);
      await emit(13, 'firstEvents', { events: takeNewEvents(listener), isReceived });
      listener.isRemoved = true;
      await step(13, 'removeSnapshotListenerFirst', 'removeSnapshotListener', { callbackId: listener.callbackId });
      await step(13, 'removeSnapshotListenerSecond', 'removeSnapshotListener', { callbackId: listener.callbackId });
    }

    async function runMain() {
      await step(0, 'useEmulator', 'useEmulator', { host: env.host, port: PORT });
      await step(0, 'clearPersistence', 'clearPersistence', {});
      await caseDocuments();
      await caseDataTypes();
      await caseFieldValues();
      await caseWriteBatch();
      await caseQueries();
      await caseCollectionGroup();
      await caseCount();
      await caseListeners();
      await caseNetwork();
      await caseMissingArguments();
      await caseSdkError();
      await caseRemoveListenerTwice();
    }

    async function runSettingsA() {
      await step('10A', 'enablePersistence', 'enablePersistence', { cacheSizeBytes: 10485760 });
      await step('10A', 'useEmulator', 'useEmulator', { host: env.host, port: PORT });
      await step('10A', 'setDocument', 'setDocument', { reference: 'settings/a', data: { v: 'A' } });
      await step('10A', 'getDocument', 'getDocument', { reference: 'settings/a' });
      await step('10A', 'terminate', 'terminate', {});
      await step('10A', 'clearPersistence', 'clearPersistence', {});
      await step('10A', 'useEmulatorAgain', 'useEmulator', { host: env.host, port: PORT });
      await step('10A', 'getDocumentAfterTerminate', 'getDocument', { reference: 'settings/a' });
    }

    async function runSettingsB() {
      await step('10B', 'disablePersistence', 'disablePersistence', {});
      await step('10B', 'useEmulator', 'useEmulator', { host: env.host, port: PORT });
      await step('10B', 'setDocument', 'setDocument', { reference: 'settings/b', data: { v: 'B' } });
      await step('10B', 'getDocument', 'getDocument', { reference: 'settings/b' });
    }

    return { lines, emit, runMain, runSettingsA, runSettingsB };
  }

  globalThis.__regressionRun = async function (phase, env) {
    const runner = createRunner(env);
    const phases = { main: runner.runMain, settingsA: runner.runSettingsA, settingsB: runner.runSettingsB };
    if (!phases[phase]) {
      throw new Error('Unknown phase ' + phase);
    }
    try {
      await phases[phase]();
    } catch (error) {
      await runner.emit('script', `error in ${phase}`, String(error && error.stack ? error.stack : error));
    }
    return runner.lines;
  };
})();

# Regression harness

The harness compares two builds of a [Capacitor Firebase](https://github.com/capawesome-team/capacitor-firebase) plugin on Android and iOS.
It installs a packed plugin build into this demo app, builds the app and runs a fixed set of cases against the local Firebase emulator.
Each step of a case writes one line to an output file.
You run the harness once with a baseline build and once with the build under test.
Then you compare the two output files step by step.

The cases call the native plugin through the Capacitor bridge (`Capacitor.nativePromise`).
So they test the native code of the plugin. The JavaScript wrapper of the package plays no role.

Today the harness covers `@capacitor-firebase/firestore`.

## Requirements

- Node.js 22 or newer.
- The dependencies of this repo (`npm ci`) and its web assets (`npm run build`). The runners copy `www` into the native projects, but they never build it.
- Java 21 or newer for the Firestore emulator. The emulator runs with the `firebase` binary of this repo (`node_modules/.bin/firebase`). It needs no login.
- Android: the Android SDK with `adb` on the `PATH` and a booted Android emulator.
- iOS: Xcode and a booted iOS simulator.
- A checkout of the Capacitor Firebase repo to pack the plugin builds.

## Files

| Path | Content |
| --- | --- |
| `run-android.mjs` | Android runner. It calls the plugin through the WebView DevTools socket. |
| `run-ios.mjs` | iOS runner. It injects the cases into the generated `public` folder and reads the output from the `Documents` folder of the app. |
| `cases/<package>.js` | The cases of one package. They run inside the WebView of the app. |
| `lib/common.mjs` | Helpers for both runners. |
| `lib/compare.mjs` | Compares two output files step by step. |
| `firebase.json` | Config for the Firestore emulator on port 8080. |

All working files go to `regression/.work/`, which git ignores:

| Path | Content |
| --- | --- |
| `packs/` | Plugin tarballs from `npm pack`. |
| `backup/<package>/` | The original package while a run swaps it. |
| `emulator/` | Working folder and logs of the emulator. |
| `emulator-cache/` | The downloaded emulator. |
| `ios-derived-data/` | Xcode derived data of the iOS builds. |
| `out/` | Output files and logs. |

## Run

Run all commands from the root of this repo, unless a step says otherwise.

### 1. Start the Firestore emulator

Use a second terminal and keep the emulator running:

```sh
mkdir -p regression/.work/emulator
cd regression/.work/emulator
FIREBASE_EMULATORS_PATH="$PWD/../emulator-cache" ../../../node_modules/.bin/firebase emulators:start --only firestore --project demo-default --config ../../firebase.json
```

The first start downloads the emulator into `regression/.work/emulator-cache`.

### 2. Pack the baseline build

Create the folders for the tarballs:

```sh
mkdir -p regression/.work/packs/baseline regression/.work/packs/new
```

In the Capacitor Firebase repo, check out the baseline (for example `main`) and pack the package.
Replace `<demo>` with the path of this repo:

```sh
cd packages/firestore
npm run build
npm pack --pack-destination <demo>/regression/.work/packs/baseline
```

### 3. Run the baseline

Android:

```sh
node regression/run-android.mjs --package firestore --tgz regression/.work/packs/baseline/capacitor-firebase-firestore-<version>.tgz --out regression/.work/out/android-baseline.txt
```

iOS:

```sh
node regression/run-ios.mjs --package firestore --tgz regression/.work/packs/baseline/capacitor-firebase-firestore-<version>.tgz --out regression/.work/out/ios-baseline.txt --udid <udid> --project-id <project id>
```

`xcrun simctl list devices booted` shows the UDID of the booted simulator.
The project ID is the one of `ios/App/App/GoogleService-Info.plist`:

```sh
/usr/libexec/PlistBuddy -c "Print :PROJECT_ID" ios/App/App/GoogleService-Info.plist
```

### 4. Pack and run the build under test

Check out the build under test in the Capacitor Firebase repo and repeat steps 2 and 3 with these changes:

- Pack into `regression/.work/packs/new`.
- Pass the tarball from `regression/.work/packs/new` with `--tgz`.
- Write to `regression/.work/out/android-new.txt` and `regression/.work/out/ios-new.txt` with `--out`.

### 5. Compare

```sh
node regression/lib/compare.mjs regression/.work/out/android-baseline.txt regression/.work/out/android-new.txt
node regression/lib/compare.mjs regression/.work/out/ios-baseline.txt regression/.work/out/ios-new.txt
```

The script prints every step whose result differs and every step that exists in only one file.
A plain `diff` of the two files works too.

## Options

`run-android.mjs`:

| Option | Content |
| --- | --- |
| `--package <name>` | Required. The package under `@capacitor-firebase/` to swap. The cases come from `cases/<name>.js`. |
| `--tgz <path>` | Required. The tarball of the build. |
| `--out <path>` | Required. The output file. |
| `--project-id <id>` | The Firebase project ID. Default: `demo-default`. |
| `--serial <serial>` | The serial of the Android emulator. Default: `emulator-5554`. |
| `--work-dir <path>` | The work folder for the backup of the package. Default: `regression/.work`. |

`run-ios.mjs`:

| Option | Content |
| --- | --- |
| `--package <name>` | Required. Same as on Android. |
| `--tgz <path>` | Required. The tarball of the build. |
| `--out <path>` | Required. The output file. |
| `--project-id <id>` | Required. The project ID of `ios/App/App/GoogleService-Info.plist`. |
| `--udid <udid>` | Required. The UDID of the booted simulator. |
| `--work-dir <path>` | The work folder for the backup of the package and the derived data. Default: `regression/.work`. |
| `--derived-data <path>` | The Xcode derived data folder. Default: `ios-derived-data` in the work folder. |
| `--skip-clean-reinstall` | Do not install a clean build at the end. |

## What a run does

1. It checks that the Firestore emulator answers on `127.0.0.1:8080`.
2. It moves the installed package to `backup/<package>` in the work folder and extracts the tarball in its place.
3. Android only: when `android/app/google-services.json` is missing, it writes one with fake values.
4. It runs `cap sync`, builds the app and installs it. On iOS it also injects the cases into the generated `public` folder.
5. It clears the emulator data of the project.
6. It runs the phases `main`, `settingsA` and `settingsB`, each in a new app process.
7. It reads the stored documents from the emulator REST API.
8. It writes the output file.

At the end, also after a failure, it stops the app, removes the fake `google-services.json` and puts the original package back.
Then it runs `cap sync` again, which also copies the clean web assets back.
The iOS runner then builds and installs a clean build.

## Output

- Each step writes one line `CASE <case> <step>: <result>`.
- Lines `CASE emulator <path>` come from the emulator REST API after the run. They show the stored value types, for example `integerValue` or `doubleValue`.
- The project ID is masked as `<projectId>`, so the Android and iOS outputs use the same text.
- A crash shows as a line `CASE <phase> CRASH: ...`. The details are in the log files.
- Each run writes `<out>.log` with all commands and their output. The iOS run also writes `<out>.console.log` with the console of the app.

## Notes

- The main phase starts with `useEmulator` and `clearPersistence` (case 0), so the local cache is empty in every run. Cases 10A and 10B run in their own app process.
- When `android/app/google-services.json` exists, the Android runner uses it. Then pass its project ID with `--project-id`.
- The iOS app uses the `GoogleService-Info.plist` of this repo. Firestore talks only to the emulator, but other Firebase SDKs of the app can contact the real project at launch.
- If a run stops in the middle, the original package stays in `backup/<package>` in the work folder. The next run refuses to start. Move the folder back to `node_modules/@capacitor-firebase/<package>` first.
- Xcode keeps absolute paths in the derived data folder, so never move it. A new folder works too, but the first build then fetches all Swift packages again.
- The emulator steps (the check, the clear and the read of the stored documents) are written for Firestore. Another package needs its own emulator steps.

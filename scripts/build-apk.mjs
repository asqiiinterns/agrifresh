// Builds the Android APK on this computer (no EAS queue): `npm.cmd run apk`.
//   1. finds Java (Android Studio's) and the Android SDK,
//   2. regenerates the native project from app.json (expo prebuild),
//   3. signs with the EAS keystore from credentials.json (so updates install over the
//      existing app); `--debug-sign` uses a test key instead (uninstall the app first),
//   4. compiles with Gradle and copies the APK into dist-apk/.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const windows = process.platform === "win32";
const debugSign = process.argv.includes("--debug-sign");

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`\n› ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", shell: windows, ...options });
}

// --- Java and Android SDK ---------------------------------------------------
// Java 17 to 21 only: newer ones print a "restricted method" warning that makes the
// native (CMake/prefab) steps fail. A portable Java 17 is downloaded once if needed.
const javaBin = (dir) => join(dir, "bin", windows ? "java.exe" : "java");
// `java -version` writes to stderr.
function javaMajor(dir) {
  const result = spawnSync(javaBin(dir), ["-version"], { encoding: "utf8" });
  return Number(/version "(\d+)/.exec(`${result.stderr}${result.stdout}`)?.[1] ?? 0);
}
const toolsDir = join(process.env.LOCALAPPDATA ?? process.env.HOME ?? root, "agrifresh-tools");
const portableJdk = join(toolsDir, "jdk-17");

function downloadJdk17() {
  if (!windows) fail("Installez un Java 17 (Temurin) et définissez JAVA_HOME.");
  console.log("\nTéléchargement d’un Java 17 portable (une seule fois, ~190 Mo)…");
  mkdirSync(toolsDir, { recursive: true });
  const zip = join(toolsDir, "jdk17.zip");
  const url = "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse";
  run("powershell", ["-NoProfile", "-Command", `"$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile '${zip}'"`]);
  const unpack = join(toolsDir, "unpack");
  run("powershell", ["-NoProfile", "-Command", `"Remove-Item -Recurse -Force '${unpack}' -ErrorAction SilentlyContinue; Expand-Archive -Path '${zip}' -DestinationPath '${unpack}' -Force; $d = Get-ChildItem '${unpack}' | Select-Object -First 1; Remove-Item -Recurse -Force '${portableJdk}' -ErrorAction SilentlyContinue; Move-Item $d.FullName '${portableJdk}'; Remove-Item -Force '${zip}'"`]);
}

const javaCandidates = [
  process.env.JAVA_HOME,
  portableJdk,
  "C:\\Program Files\\Android\\Android Studio\\jbr",
  "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
].filter(Boolean);
let javaHome = javaCandidates.find((dir) => existsSync(javaBin(dir)) && javaMajor(dir) >= 17 && javaMajor(dir) <= 21);
if (!javaHome) {
  downloadJdk17();
  if (!existsSync(javaBin(portableJdk))) fail("Le téléchargement de Java 17 a échoué.");
  javaHome = portableJdk;
}

const sdkCandidates = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk"),
  process.env.HOME && join(process.env.HOME, "Library", "Android", "sdk"),
].filter(Boolean);
const sdk = sdkCandidates.find((dir) => existsSync(join(dir, "platform-tools")));
if (!sdk) fail("SDK Android introuvable : ouvrez Android Studio une fois pour l’installer, ou définissez ANDROID_HOME.");

const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, NODE_ENV: "production" };
console.log(`Java : ${javaHome}\nSDK  : ${sdk}`);

// --- Signing key ------------------------------------------------------------
let signing = null;
const credentialsFile = join(root, "credentials.json");
if (existsSync(credentialsFile)) {
  const keystore = JSON.parse(readFileSync(credentialsFile, "utf8"))?.android?.keystore;
  if (!keystore?.keystorePath) fail("credentials.json ne contient pas de clé Android (android.keystore).");
  const storeFile = resolve(root, keystore.keystorePath);
  if (!existsSync(storeFile)) fail(`Fichier de clé introuvable : ${storeFile}`);
  signing = { storeFile: storeFile.replace(/\\/g, "/"), storePassword: keystore.keystorePassword, keyAlias: keystore.keyAlias, keyPassword: keystore.keyPassword };
} else if (!debugSign) {
  fail([
    "Clé de signature absente (credentials.json).",
    "Récupérez la clé EAS une fois : npx.cmd eas-cli@latest credentials → Android → preview",
    "→ « credentials.json: Upload/Download credentials between EAS servers and your local json »",
    "→ « Download credentials from EAS to credentials.json ».",
    "Pour un essai sans cette clé : npm.cmd run apk -- --debug-sign (désinstallez d’abord l’appli du téléphone).",
  ].join("\n  "));
}

// --- Native project ---------------------------------------------------------
run("npx", ["expo", "prebuild", "--platform", "android", "--no-install"], { cwd: root, env });

if (signing) {
  const gradleFile = join(root, "android", "app", "build.gradle");
  let gradle = readFileSync(gradleFile, "utf8");
  const quote = (value) => `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (!gradle.includes("signingConfigs {\n        debug {")) fail("Format inattendu de android/app/build.gradle (signingConfigs).");
  gradle = gradle.replace("signingConfigs {\n        debug {", `signingConfigs {
        release {
            storeFile file(${quote(signing.storeFile)})
            storePassword ${quote(signing.storePassword)}
            keyAlias ${quote(signing.keyAlias)}
            keyPassword ${quote(signing.keyPassword)}
        }
        debug {`);
  const releaseBlock = gradle.indexOf("        release {\n            // Caution!");
  if (releaseBlock < 0) fail("Format inattendu de android/app/build.gradle (buildTypes.release).");
  const before = gradle.slice(0, releaseBlock);
  const after = gradle.slice(releaseBlock).replace("signingConfig signingConfigs.debug", "signingConfig signingConfigs.release");
  writeFileSync(gradleFile, before + after);
  console.log("\nSignature : clé EAS (mise à jour possible par-dessus l’appli installée).");
} else {
  console.log("\nSignature : clé de test (désinstallez l’appli du téléphone avant d’installer cet APK).");
}

// --- Compile ----------------------------------------------------------------
// Full path: cmd.exe does not always look in the working directory.
const gradlew = join(root, "android", windows ? "gradlew.bat" : "gradlew");
// Real phones only (ARM): faster than building the emulator architectures too.
run(gradlew, ["assembleRelease", "-PreactNativeArchitectures=arm64-v8a,armeabi-v7a", "--no-daemon"], { cwd: join(root, "android"), env });

const built = join(root, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
if (!existsSync(built)) fail("APK non trouvé après la compilation.");
const version = JSON.parse(readFileSync(join(root, "app.json"), "utf8")).expo.version;
const now = new Date();
const pad = (value) => String(value).padStart(2, "0");
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
mkdirSync(join(root, "dist-apk"), { recursive: true });
const target = join(root, "dist-apk", `AgriFresh-${version}-${stamp}${signing ? "" : "-test"}.apk`);
copyFileSync(built, target);
console.log(`\n✔ APK prêt : ${target}\n`);

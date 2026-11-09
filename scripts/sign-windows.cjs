// electron-builder's Windows sign hook (win.signtoolOptions.sign, passed by scripts/release.mjs
// only when the Azure Trusted Signing variables are set): signs one file with jsign against
// Azure Trusted Signing, so a Windows build signs from this Mac. No Windows machine, no signtool.
//
//   AZURE_TS_ENDPOINT   e.g. https://eus.codesigning.azure.net (the account's region endpoint)
//   AZURE_TS_ACCOUNT    the Trusted Signing account name
//   AZURE_TS_PROFILE    its certificate profile name
//   AZURE_TS_TOKEN      an access token for https://codesigning.azure.net; when unset it's taken
//                       from `az account get-access-token --resource https://codesigning.azure.net`
//   JSIGN               the jsign command (default `jsign`; a .jar path runs with `java -jar`)
//
// MinGit's own binaries (resources/git/…) keep their upstream signatures: re-signing 200 files
// per release would only spend signatures. electron-builder asks once per hash (sha1, sha256);
// jsign writes one sha256 signature, so the sha1 call is skipped.
const { execFileSync } = require("node:child_process");

let token = null;
function accessToken() {
  if (process.env.AZURE_TS_TOKEN) return process.env.AZURE_TS_TOKEN;
  if (!token) {
    token = execFileSync("az", ["account", "get-access-token", "--resource", "https://codesigning.azure.net", "--query", "accessToken", "-o", "tsv"], { encoding: "utf8" }).trim();
  }
  return token;
}

module.exports = async function sign(config) {
  const file = config.path;
  if (config.hash && config.hash !== "sha256") return;
  if (/[\\/]resources[\\/]git[\\/]/.test(file)) return;
  const { AZURE_TS_ENDPOINT: endpoint, AZURE_TS_ACCOUNT: account, AZURE_TS_PROFILE: profile } = process.env;
  if (!endpoint || !account || !profile) throw new Error("sign-windows: AZURE_TS_ENDPOINT, AZURE_TS_ACCOUNT and AZURE_TS_PROFILE must be set");
  const jsign = process.env.JSIGN || "jsign";
  const [cmd, pre] = jsign.endsWith(".jar") ? ["java", ["-jar", jsign]] : [jsign, []];
  const args = [
    ...pre,
    "--storetype", "TRUSTEDSIGNING",
    "--keystore", new URL(endpoint).host,
    "--storepass", accessToken(),
    "--alias", `${account}/${profile}`,
    "--tsaurl", "http://timestamp.acs.microsoft.com",
    "--tsmode", "RFC3161",
    "--alg", "SHA-256",
    "--name", config.name || require("../core/brand.mjs").BRAND.name,
    "--replace",
    file,
  ];
  execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
};
